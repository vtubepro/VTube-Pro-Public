// A STARVED OBS page: OBS is showing the page (it is being driven) but frames arrive seconds apart. Seen next to games
// that keep the graphics card busy (a user's RTX 3080 10 GB: "1 frame every 5-10 seconds" in any game over ~50 % GPU).
// "Lower quality automatically" (autoLower.ts) cannot help there on its own: it steps one preset per ~4 s of frames, and
// a page making one frame every 5-10 s gives it a window every 5-10 s; its old rule even ignored every window under
// 3 fps ("a page that isn't being driven says nothing"). This guard decides by the WALL CLOCK (a 500 ms timer, src/output.ts),
// not by frames, and tells "not driven" (the page is hidden: document.visibilityState, OBS's source visibility events)
// apart from "driven but starved" (visible, not loading, under STARVE_FPS for STARVE_SPAN_MS).
//
// Levels (what src/output.ts + Graphics.setStarved do with them):
//   0  normal.
//   1  starved: the lightest preset at once (not one step per 4 s), the render scale pinned at its floor, the frame rate
//      capped at 30, every unused post-pipeline target released.
//   2  deep: also the room's own image textures drawn from copies at most 1024 px (src/stage/gfx/vramRelief.ts): the
//      graphics card's memory is the usual reason a page next to a game gets one frame every few seconds (Windows pages a
//      background app's textures in and out of the card's memory for every frame). Entered when level 1 has not helped
//      after DEEP_AFTER_MS, or at once when the helper reports the card's memory nearly full (shared/gpuStat.ts).
// Back up one level at a time once the page has been healthy for CLEAR_MS of driven time (doubled after every relapse
// within RELAPSE_MS, up to CLEAR_MAX_MS); level 2 → 1 (full-size textures back) also waits until the helper says they fit.
// Starved again at level 1 after coming back from 2 (the full-size textures did not fit after all): straight back to 2,
// and the next way back up waits twice as long. Without the helper's memory reading (macOS, Linux, and since 14.1 Windows
// AMD / Intel cards unless VTP_GPU_WATCH=counters) nothing else stopped a 2 → 1 → 2 cycle every ~30 s next to a game
// that fills the card, with 8 s of frames seconds apart in each.
// Pure logic (tools/gamefps_unit.ts); the caller feeds it frames and a timer.

export type StarveLevel = 0 | 1 | 2;

/** A driven page under this many frames a second ... */
export const STARVE_FPS = 3;
/** ... for this long (driven, nothing loading) is starved. */
export const STARVE_SPAN_MS = 4000;
/** Level 1 did not bring the frames back within this long: level 2. */
export const DEEP_AFTER_MS = 8000;
/** Healthy: at least this many frames a second, no gap over CLEAR_GAP_MS ... */
export const CLEAR_FPS = 15;
export const CLEAR_GAP_MS = 500;
/** ... for this long (driven time) before stepping back up one level. */
export const CLEAR_MS = 20000;
export const CLEAR_MAX_MS = 320000;
/** Starved again within this long after leaving a level: the next way back up waits twice as long. */
export const RELAPSE_MS = 600000;
/** The helper's telemetry: the card's memory this full (used / total) counts as "nearly full". */
export const VRAM_NEARLY_FULL = 0.9;
/** Full-size room textures come back only when they leave this much of the card free (used + restore <= total × this). */
export const VRAM_RESTORE_FIT = 0.92;
/** History kept (ms). */
const KEEP_MS = 30000;
/** A timer look later than this is a sleeping PC or a heavily throttled hidden timer, not a starved page (a starved page's
 *  timer comes a frame late: seconds, not tens of seconds). Its span is no evidence (review round 1). */
export const LATE_LOOK_MS = 15000;

/** What the helper last said about the graphics card (shared/gpuStat.ts), or null (no helper telemetry). */
export interface StarveGpu { usedMB: number; totalMB: number; util: number | null; at: number }

interface Seg { t0: number; t1: number; ok: boolean; frames: number; maxGap: number }

export interface StarveInfo {
  level: StarveLevel; reason: string; since: number | null; entries: number; clearNeedMs: number;
  /** Last judgement: driven fps over the span (NaN = not enough driven time), the longest gap in it (ms). */
  fps: number; maxGap: number;
}

export class StarveGuard {
  level: StarveLevel = 0;
  reason = '';
  /** When the current level was entered (null at level 0). */
  since: number | null = null;
  /** How many times the page became starved (diagnostics). */
  entries = 0;
  private segs: Seg[] = [];
  private lastAt = -1;
  private framesSince = 0;
  private lastFrameAt = -1;
  private gapSince = 0;
  private leftAt = -1e12;
  private clearNeed = CLEAR_MS;
  private lastFps = NaN;
  private lastMaxGap = 0;
  /** Level 1 was reached by coming back down from level 2 (not up from 0). */
  private fromDeep = false;
  /** The page was driven and not busy at the last look (a span is evidence only when it was at both ends). */
  private prevOk = false;
  /** Frames drawn since the page loaded (the OBS page's "has OBS ever drawn this source" check). */
  totalFrames = 0;

  /** A frame was drawn (or at least started: the page's render loop ran) at `now` (ms). */
  frame(now: number) {
    this.framesSince++;
    this.totalFrames++;
    if (this.lastFrameAt >= 0) this.gapSince = Math.max(this.gapSince, now - this.lastFrameAt);
    this.lastFrameAt = now;
  }

  /**
   * The timer's look (every ~500 ms; a late look covers the whole time since the last one). `driven` = the page is shown
   * (visible document, OBS source not hidden); `busy` = frames are legitimately missing right now (a room / model
   * loading, a transition covering the page, a party game over it). Returns the level to apply (changed or not).
   */
  observe(now: number, driven: boolean, busy: boolean, gpu: StarveGpu | null = null, restoreBytes = 0): StarveLevel {
    if (this.lastAt < 0) { this.lastAt = now; this.framesSince = 0; this.gapSince = 0; this.prevOk = driven && !busy; return this.level; }
    // the gap still open since the last frame counts too (a page that stopped drawing altogether)
    const open = this.lastFrameAt >= 0 ? now - this.lastFrameAt : now - this.lastAt;
    // a span is evidence only when the page was driven and free at BOTH ends and the look came in time: a look after a
    // hidden stretch or a system sleep covered time the page was not drawn on purpose (review round 1)
    const okNow = driven && !busy;
    const ok = okNow && this.prevOk && now - this.lastAt <= LATE_LOOK_MS;
    this.push({ t0: this.lastAt, t1: now, ok, frames: this.framesSince, maxGap: Math.max(this.gapSince, open) });
    this.lastAt = now; this.framesSince = 0; this.gapSince = 0; this.prevOk = okNow;
    if (!ok) return this.level;           // (no evidence either way: keep the level, pause the clocks)
    const span = this.recent(STARVE_SPAN_MS);
    this.lastFps = span.fps; this.lastMaxGap = span.maxGap;
    const starved = span.full && span.fps < STARVE_FPS;
    const vramFull = !!gpu && gpu.totalMB > 0 && gpu.usedMB / gpu.totalMB >= VRAM_NEARLY_FULL;
    if (starved) {
      if (this.level === 0) {
        this.entries++;
        // a relapse soon after the last way back up: the next way back waits twice as long
        this.clearNeed = now - this.leftAt < RELAPSE_MS ? Math.min(CLEAR_MAX_MS, this.clearNeed * 2) : CLEAR_MS;
        this.fromDeep = false;
        return this.set(vramFull ? 2 : 1, now, vramFull ? 'frames seconds apart, graphics memory nearly full' : `frames seconds apart (${span.fps.toFixed(1)} a second)`);
      }
      if (this.level === 1 && this.since !== null && (vramFull || this.fromDeep || now - this.since >= DEEP_AFTER_MS)) {
        // (back from 2 and starved again: the full-size textures were the trouble — 2 at once, and a longer wait next time)
        if (this.fromDeep) this.clearNeed = Math.min(CLEAR_MAX_MS, this.clearNeed * 2);
        const why = vramFull ? 'graphics memory nearly full' : this.fromDeep ? 'starved again once the full-size textures came back' : 'still starved on the lightest look';
        this.fromDeep = false;
        return this.set(2, now, why);
      }
      return this.level;
    }
    if (this.level === 0) return 0;
    // healthy long enough at this level? (driven time only; a page hidden meanwhile neither helps nor hurts)
    const clear = this.recent(this.clearNeed);
    const healthy = clear.full && clear.fps >= CLEAR_FPS && clear.maxGap <= CLEAR_GAP_MS && this.since !== null && now - this.since >= this.clearNeed;
    if (!healthy) return this.level;
    if (this.level === 2) {
      // full-size textures back only when the card has room for them (no telemetry: on the frames alone). Gated only when
      // there IS something to restore: with nothing, a game holding the memory kept the page at half scale all session
      // (review round 1)
      if (restoreBytes > 0 && gpu && gpu.totalMB > 0 && gpu.usedMB + restoreBytes / 1048576 > gpu.totalMB * VRAM_RESTORE_FIT) return this.level;
      this.fromDeep = true;
      return this.set(1, now, 'frames healthy again');
    }
    this.leftAt = now;
    return this.set(0, now, '');
  }

  /** Driven, not-busy time of the last `ms` (walking back from now): frames per second and the longest gap in it.
   *  `full` = that much continuous driven time exists (a hidden / loading stretch in between cuts it short). */
  recent(ms: number): { full: boolean; fps: number; maxGap: number; spanMs: number } {
    let span = 0, frames = 0, maxGap = 0;
    for (let i = this.segs.length - 1; i >= 0 && span < ms; i--) {
      const s = this.segs[i];
      if (!s.ok) break;
      span += s.t1 - s.t0; frames += s.frames; maxGap = Math.max(maxGap, s.maxGap);
    }
    return { full: span >= ms - 1, fps: span > 0 ? (frames * 1000) / span : NaN, maxGap, spanMs: span };
  }

  private push(s: Seg) {
    const last = this.segs[this.segs.length - 1];
    if (last && last.ok === s.ok && last.t1 === s.t0 && s.t1 - last.t0 <= 1000) { last.t1 = s.t1; last.frames += s.frames; last.maxGap = Math.max(last.maxGap, s.maxGap); }
    else this.segs.push(s);
    const keep = Math.max(KEEP_MS, this.clearNeed + 2000);
    while (this.segs.length && s.t1 - this.segs[0].t1 > keep) this.segs.shift();
  }

  private set(l: StarveLevel, now: number, why: string): StarveLevel {
    this.level = l; this.reason = why; this.since = l ? now : null;
    // (each level is judged afresh: the clean time counts from the change)
    return l;
  }

  /** The page became visible / its OBS source shown or active again: the gap since the last frame was not drawn on
   *  purpose — dropped, not scored (the next look starts a fresh span). */
  resume(now: number) { this.lastAt = now; this.framesSince = 0; this.gapSince = 0; this.lastFrameAt = -1; this.prevOk = false; }

  /** Forget everything (a new page state, tests). */
  reset() { this.level = 0; this.reason = ''; this.since = null; this.fromDeep = false; this.segs = []; this.lastAt = -1; this.framesSince = 0; this.lastFrameAt = -1; this.gapSince = 0; this.prevOk = false; }

  info(): StarveInfo {
    return { level: this.level, reason: this.reason, since: this.since, entries: this.entries, clearNeedMs: this.clearNeed, fps: +this.lastFps.toFixed(2), maxGap: Math.round(this.lastMaxGap) };
  }
}

/** The card's memory as the helper reports it: nearly full? (null = unknown). */
export function vramNearlyFull(gpu: StarveGpu | null): boolean | null {
  if (!gpu || !(gpu.totalMB > 0)) return null;
  return gpu.usedMB / gpu.totalMB >= VRAM_NEARLY_FULL;
}
