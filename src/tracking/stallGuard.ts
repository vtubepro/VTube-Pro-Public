// Stall mode for face tracking (beta.13.5; research/tracking_gpu_rca/RCA.md §4 P2). A game in the foreground that keeps
// the graphics card at 90-100 % starves every WebGL call of the browser, MediaPipe's with it: a user's RTX 3060 went from
// face 15-25 ms / 20-30 results a second to 160-900 ms / 0-4 (back within seconds on alt-tab); the owner's 5090 next to a
// real UE5 game: GPU face 39-57 ms / ~15 a second, the processor face 31 ms with every model there, 50-80 ms with pose and
// hands left on the card. Auto's normal move (delegatePolicy.ts) ticks only on face results, needs 3 s of slow readings,
// can be held back for minutes and times a candidate next to a stalled worker: 7-14 s at best.
//
// This guard is judged on the WALL CLOCK (Tracker.process runs on every studio tick, results or not; checked every 250 ms):
//   STALL reading   (relative) the face run in flight for over max(150 ms, 4 × the face's healthy p50), or fewer than
//                   0.4 × the camera's frames a second as results while runs take over max(60 ms, 3 × the healthy p50).
//   GAME reading    (absolute, round 1: the owner's Bodycam run with the studio STARTED while the game ran learned its
//                   "healthy" p50 under the game, 29.6 ms, so the relative reading never fired: 17 results a second, p10
//                   7, for 75 s) fewer face results than min(20, 0.8 × the face goal: min(camera fps, 30, the face cap)),
//                   or runs over max(the goal's frame budget, 60 ms) — under the tracker's normal band of 20-30 results
//                   a second and 35-45 ms laptop / processor runs, review round 2 — WHILE the graphics queue is
//                   measurably waited on: the processor face's
//                   readback over 8 ms (1.5-2 ms normally; 10-90 ms next to the game), any face readback over 40 ms, the
//                   1x1 sync probe (gpuSyncProbe.ts) over 12 ms, or the helper reporting the card busy. Without that
//                   wait a low rate is a slow processor, not a game: no stall mode (the reason says so).
//   ENTER           1 s of stall readings in a row, or 1.5 s of game readings (GC pauses / camera hiccups do not count).
//   STALL MODE      (Tracker): the face goes to the processor at once (a timed try that ignores Auto's back-off, its
//                   candidate fed every camera frame and its results used), pose and hands at most 10 a second and then
//                   off the card too, no room preview (src/ui/gameMode.ts), the studio canvas drawn less, no look back at
//                   the card while a game may still hold it.
//   EXIT            10 s at min(18, 0.8 x the face goal) results a second or more (a 15 fps camera: 12; not the camera's rate: a 60 fps camera's
//                   face lands at 30-45; a recovered 20-a-second face leaves, the in-game 17 stays), runs within
//                   max(2 × the pre-stall p50, 60 ms, 1.1 × the goal's frame budget), no graphics-queue wait
//                   over 1.5 × the entry limits (hysteresis) and the helper not reporting the card busy; a relapse within
//                   3 minutes doubles that (up to 160 s).
//                   OR (beta.14.1) cleanExitMs (or the hold, when longer) with nothing waiting on the graphics queue even
//                   at cleanWaitX × the entry limits (hysteresis both ways: a wait between that and the entry limit holds
//                   stall mode, it does not flap out and back), face results arriving and no run stuck in flight, whatever
//                   the rate: a processor face that tops out under 18 a second on this PC (the GPU-free face is
//                   single-threaded wasm, 60-85 ms a run on a 60 fps camera) never met the bar above, so stall mode, the
//                   paused room preview with it, outlived the game until the camera stopped. Not while nothing can see
//                   the card (no 1x1 round trip measured and no helper reading): no evidence is not "clean".
// `gpu` (beta.14.1): a graphics-queue wait was measured when stall mode started, or held for sustainMs while it lasted (a
// single reading, or a readback average left over from the worker the face just moved off, does not count). The studio's
// words name a game on the graphics card only then; the relative reading needs no such evidence (a CPU-heavy game, an
// encoder, an antivirus scan), and "a game needs your graphics card" next to a card at 36 % read as a bug (user report).
// The healthy p50 is learned from the last 30 s of results before stall mode STARTS (also while a stall / game reading
// builds up: excluding those left it at 0 for a studio started next to a game, review round 2) and kept as it was while
// stall mode lasts. On the way out it is relearned from the stall-mode face's own results of the last 30 s (the face stays
// where stall mode put it, Tracker moves nothing back): the pre-stall one is gone by then (the clean exit alone takes
// 30 s), and a p50 of 0 read a 7-a-second processor face as a fresh stall, back on ~1.3 s after every exit (Director's
// 14.1 release review). The pre-stall p50 would not do either: 3 x a GPU face's 15 ms is under a processor face's 140 ms.
// `why` says in plain words why stall mode is (not) on right now (state.json, the beacon, the tracker log). Pure:
// tools/gamefps_unit.ts.

export const STALL = {
  /** Readings every this often (ms). */
  everyMs: 250,
  /** No judgement in the first seconds after the first face result (model warm-up, first-frame allocations). */
  armMs: 3000,
  /** The judged window for the result rate and the run times. */
  windowMs: 1000,
  inFlightMinMs: 150, inFlightX: 4,
  rateShare: 0.4, slowMinMs: 60, slowX: 3,
  sustainMs: 1000,
  /** The game reading (absolute): the face goal is min(camera fps, goalHz, the face cap); results under goalShare × it, or
   *  a median run over its frame budget, while the graphics queue is waited on, for gameSustainMs. */
  goalHz: 30, goalShare: 0.8, gameSustainMs: 1500,
  /** ... the rate bar never above this (results a second: the tracker's normal band starts at 20), and stall mode's exit
   *  needs min(exitHz, goalShare x the goal). */
  gameMaxHz: 20, exitHz: 18,
  /** Graphics-queue wait: the processor face's readback (ms, EMA), any face's readback, the 1x1 sync probe (ms). */
  rbCpuMs: 8, rbAnyMs: 40, syncMs: 12,
  /** ... and on the way out the wait must be under 1.5 × those (hysteresis). */
  exitWaitX: 1.5,
  /** The camera counts as delivering at this many frames a second or more. */
  camMinFps: 8,
  /** Stall mode: pose runs per second at most (on either side; the 'lite' pose model meanwhile), hand-model runs. */
  bodyHz: 10, handsHz: 5,
  holdMs: 10000, maxHoldMs: 160000, relapseMs: 180000,
  /** Stall mode also ends after this long (or the hold, when longer) with nothing waiting on the graphics queue even at
   *  cleanWaitX × the entry limits, whatever the result rate (beta.14.1). */
  cleanExitMs: 30000, cleanWaitX: 0.67,
  healthyX: 2,
  /** The healthy p50: results of the last this long outside stall mode. */
  baseMs: 30000,
};

export interface StallInput {
  now: number;
  /** Camera frames per second (measured; 0 = not delivering). */
  camFps: number;
  /** How long the face run in flight has been running (0 = none). */
  inFlightMs: number;
  /** The helper's GPU telemetry says the card is busy (shared/gpuStat.ts; null = unknown). */
  gpuBusy?: boolean | null;
  /** The face's readback per run (ms, the worker's split EMA) and whether the face runs on the processor. */
  rbMs?: number; faceCpu?: boolean;
  /** The 1x1 graphics-queue round trip (ms, gpuSyncProbe.ts; < 0 = not measured: no WebGL in a worker, a lost context). */
  syncMs?: number;
  /** The face's own cap (results per second; 0 = none). */
  capHz?: number;
}

/** The face rate stall mode judges against: the camera's rate up to 30 (and the face's own cap). */
export function stallGoalHz(camFps: number, capHz = 0) { return Math.min(camFps, STALL.goalHz, capHz > 0 ? capHz : Infinity); }

/** The graphics queue is measurably waited on (a game holds the card): what was measured, or '' when nothing waits. `k`
 *  scales the ms limits: the exit uses STALL.exitWaitX (a processor face next to a busy but not starving card read 6-9 ms
 *  of readback at 28-30 results a second in the e2e: with one limit for both ways the exit flapped for 20 s). */
export function gpuWait(i: Pick<StallInput, 'rbMs' | 'faceCpu' | 'syncMs' | 'gpuBusy'>, k = 1): string {
  const rb = i.rbMs ?? 0, sync = i.syncMs ?? 0;
  if (i.gpuBusy === true) return 'VTube Pro reports the graphics card busy';
  if (sync >= STALL.syncMs * k) return `a graphics-queue round trip takes ${Math.round(sync)} ms`;
  if (i.faceCpu && rb >= STALL.rbCpuMs * k) return `the processor face waits ${Math.round(rb)} ms a run on the graphics queue`;
  if (rb >= STALL.rbAnyMs * k) return `the face waits ${Math.round(rb)} ms a run on the graphics card`;
  return '';
}

export interface StallState {
  gameMode: boolean;
  /** A stall reading right now (before sustainMs). */
  severe: boolean;
  /** Face results per second and the median run (ms) over the last window; the healthy p50 (ms, 0 = not learned). */
  hz: number; ms: number; base: number;
  /** Stall mode was entered / left by this step. */
  entered: boolean; left: boolean;
  since: number | null; entries: number; holdMs: number; reason: string;
  /** Why stall mode is (not) on right now, in plain words (diagnostics). */
  why: string;
  /** The face goal (results a second) judged against. */
  goal: number;
  /** Stall mode: a graphics-queue wait was measured when it started or since (the words may name the graphics card). */
  gpu: boolean;
}

const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

export class StallGuard {
  private runs: { t: number; ms: number }[] = [];
  private healthy: { t: number; ms: number }[] = [];
  /** Stall mode: the face's results of the last baseMs (the healthy p50 on the way out). */
  private stallRuns: { t: number; ms: number }[] = [];
  private firstAt = -1;
  private badSince = -1;
  private gameSince = -1;
  private goodSince = -1;
  /** Stall mode: since when nothing waits on the graphics queue (-1 = it does / not in stall mode). */
  private cleanSince = -1;
  /** Stall mode: since when a graphics-queue wait is read (-1 = none). */
  private waitSince = -1;
  private gpuSeen = false;
  private leftAt = -1e12;
  private lastAt = -1e12;
  gameMode = false;
  since: number | null = null;
  entries = 0;
  holdMs = STALL.holdMs;
  reason = '';
  private last: StallState = { gameMode: false, severe: false, hz: 0, ms: 0, base: 0, entered: false, left: false, since: null, entries: 0, holdMs: STALL.holdMs, reason: '', why: 'no face results yet', goal: 0, gpu: false };
  private forced: '' | 'entered' | 'left' = '';

  /** A face result arrived (`ms` = the run's own time in the worker). */
  result(now: number, ms: number) {
    if (this.firstAt < 0) this.firstAt = now;
    this.runs.push({ t: now, ms });
    // (warm-up runs are not "healthy"; every run until stall mode starts is — the median shrugs off the 1-1.5 s of stall
    //  readings before it, and a studio started next to a game learns the game's figure instead of none)
    if (!this.gameMode && now - this.firstAt >= STALL.armMs) this.healthy.push({ t: now, ms });
    else if (this.gameMode) this.stallRuns.push({ t: now, ms });
    this.prune(now);
  }

  private prune(now: number) {
    while (this.runs.length && this.runs[0].t < now - Math.max(STALL.windowMs, 2000)) this.runs.shift();
    // (in stall mode the pre-stall p50 stays as it was: decayed to nothing it turned the exit's run-time test into a bare
    //  25 ms, which a processor face over 25 ms never met — review round 1)
    while (this.healthy.length && ((!this.gameMode && this.healthy[0].t < now - STALL.baseMs) || this.healthy.length > 2000)) this.healthy.shift();
    while (this.stallRuns.length && (this.stallRuns[0].t < now - STALL.baseMs || this.stallRuns.length > 2000)) this.stallRuns.shift();
  }

  /** The face's healthy p50 (ms; 0 = not learned yet: fewer than 10 healthy results). */
  base(): number { return this.healthy.length >= 10 ? median(this.healthy.map((r) => r.ms)) : 0; }

  step(i: StallInput): StallState {
    const now = i.now;
    if (now - this.lastAt < STALL.everyMs && !this.forced) return { ...this.last, entered: false, left: false };
    this.lastAt = now;
    this.prune(now);
    const from = now - STALL.windowMs;
    const win = this.runs.filter((r) => r.t >= from);
    const hz = (win.length * 1000) / STALL.windowMs;
    const med = win.length ? median(win.map((r) => r.ms)) : this.runs.length ? this.runs[this.runs.length - 1].ms : 0;
    const base = this.base();
    const armed = this.firstAt >= 0 && now - this.firstAt >= STALL.armMs;
    const camOk = i.camFps >= STALL.camMinFps;
    const goal = stallGoalHz(i.camFps, i.capHz);
    const budget = goal > 0 ? 1000 / goal : Infinity;
    const stuck = i.inFlightMs > Math.max(STALL.inFlightMinMs, STALL.inFlightX * base);
    const slow = hz < STALL.rateShare * i.camFps && med > Math.max(STALL.slowMinMs, STALL.slowX * base);
    const severe = armed && camOk && (stuck || slow);
    // the absolute game reading (no learned p50 needed: a studio started next to a running game)
    const wait = gpuWait(i);
    const lowRate = hz < Math.min(STALL.gameMaxHz, STALL.goalShare * goal), overBudget = med > Math.max(budget, STALL.slowMinMs);
    const game = armed && camOk && (lowRate || overBudget) && !!wait;
    let entered = false, left = false, why = '';
    if (severe) { this.goodSince = -1; if (this.badSince < 0) this.badSince = now; }
    else this.badSince = -1;
    if (game) { this.goodSince = -1; if (this.gameSince < 0) this.gameSince = now; }
    else this.gameSince = -1;
    const rate = `${hz.toFixed(0)} face results a second (goal ${goal.toFixed(0)}), ${Math.round(med)} ms each`;
    if (this.forced) {
      entered = this.forced === 'entered'; left = this.forced === 'left'; this.forced = '';
      why = this.gameMode ? 'forced on (test)' : 'forced off (test)';
    } else if (!this.gameMode) {
      const relOn = severe && now - this.badSince >= STALL.sustainMs, gameOn = game && now - this.gameSince >= STALL.gameSustainMs;
      if (relOn || gameOn) {
        this.gameMode = true; this.since = now; this.entries++; entered = true;
        // a relapse soon after leaving: stay twice as long next time
        this.holdMs = now - this.leftAt < STALL.relapseMs ? Math.min(STALL.maxHoldMs, this.holdMs * 2) : STALL.holdMs;
        this.reason = relOn ? (stuck ? `a face run in flight for ${Math.round(i.inFlightMs)} ms` : `${hz.toFixed(0)} face results a second, ${Math.round(med)} ms each`)
          : `${rate}; ${wait}`;
        this.goodSince = -1; this.cleanSince = -1; this.waitSince = -1; this.stallRuns = [];
        this.gpuSeen = !!wait;
        why = `on: ${this.reason}`;
      } else if (this.firstAt < 0) why = 'no face results yet';
      else if (!armed) why = 'the face model is warming up';
      else if (!camOk) why = `the camera delivers ${i.camFps.toFixed(0)} frames a second (under ${STALL.camMinFps}: not judged)`;
      else if (severe || game) why = `stall readings for ${((now - Math.min(severe ? this.badSince : Infinity, game ? this.gameSince : Infinity)) / 1000).toFixed(1)} s (${severe ? rate : `${rate}; ${wait}`})`;
      else if (lowRate || overBudget) why = `off: ${rate}, but nothing waits on the graphics card (readback ${(i.rbMs ?? 0).toFixed(1)} ms, round trip ${(i.syncMs ?? 0) < 0 ? 'not measured' : `${(i.syncMs ?? 0).toFixed(1)} ms`}): a slow processor, not a game`;
      else why = `off: healthy (${rate})`;
    } else {
      const runOk = med <= Math.max(STALL.healthyX * base, STALL.slowMinMs, 1.1 * budget);
      const flightOk = i.inFlightMs <= Math.max(STALL.inFlightMinMs, STALL.inFlightX * base);
      const waitOut = gpuWait(i, STALL.exitWaitX);
      const exitHz = Math.min(STALL.exitHz, STALL.goalShare * goal);   // (a 15 fps camera leaves at 12/s; 24 / 30 / 60 fps at 18)
      const healthy = !severe && camOk && hz >= exitHz && runOk && flightOk && !waitOut;
      if (!healthy) this.goodSince = -1;
      else if (this.goodSince < 0) this.goodSince = now;
      // (nothing waits on the graphics queue, whatever the rate: this PC's processor, not a game — beta.14.1). Judged on
      // the stall-mode face itself, not the `severe` reading: that compares against the raw camera rate and the GPU face's
      // pre-stall p50, which a processor face on a 60 fps camera never meets (review round 1 of beta.14.1). Blind (no
      // round trip measured, no helper reading): no clean exit, only the healthy one.
      const waitClean = gpuWait(i, STALL.cleanWaitX);
      const blind = (i.syncMs ?? 0) < 0 && (i.gpuBusy ?? null) === null;
      const flightClean = i.inFlightMs <= Math.max(STALL.inFlightMinMs, STALL.inFlightX * base, STALL.slowX * med);
      const clean = camOk && win.length > 0 && flightClean && !waitClean && !blind;
      if (!clean) this.cleanSince = -1;
      else if (this.cleanSince < 0) this.cleanSince = now;
      if (!wait) this.waitSince = -1;
      else if (this.waitSince < 0) this.waitSince = now;
      if (wait && now - this.waitSince >= STALL.sustainMs) this.gpuSeen = true;
      const cleanMs = Math.max(STALL.cleanExitMs, this.holdMs);
      const healthyOut = healthy && now - this.goodSince >= this.holdMs, cleanOut = clean && now - this.cleanSince >= cleanMs;
      if (healthyOut || cleanOut) {
        this.gameMode = false; this.since = null; this.leftAt = now; left = true; this.goodSince = -1; this.badSince = -1; this.gameSince = -1; this.cleanSince = -1; this.waitSince = -1;
        // (the healthy p50 from here on: the face as it runs now, not 0 — see the header)
        if (this.stallRuns.length >= 10) this.healthy = this.stallRuns;
        this.stallRuns = [];
        why = healthyOut ? `off: healthy for ${Math.round(this.holdMs / 1000)} s`
          : `off: nothing waited on the graphics card for ${Math.round(cleanMs / 1000)} s (${this.gpuSeen ? 'the game let go of it; ' : ''}${hz.toFixed(0)} face results a second is this PC's processor${this.gpuSeen ? '' : ', not a game'})`;
      } else why = healthy ? `on: healthy for ${((now - this.goodSince) / 1000).toFixed(0)} of ${Math.round(this.holdMs / 1000)} s`
        : clean ? `on: nothing waits on the graphics card for ${((now - this.cleanSince) / 1000).toFixed(0)} of ${Math.round(cleanMs / 1000)} s`
        : `on: ${!camOk ? 'no camera frames' : waitOut ? waitOut : waitClean ? `${waitClean} (under the entry limit, over the way out)` : hz < exitHz ? `${hz.toFixed(0)} face results a second, under ${exitHz.toFixed(0)}${blind ? ' (nothing can see the graphics card here)' : ''}` : !runOk ? `${Math.round(med)} ms a run` : !flightOk ? `a face run in flight for ${Math.round(i.inFlightMs)} ms` : rate}`;
    }
    this.last = { gameMode: this.gameMode, severe: severe || game, hz, ms: med, base, entered, left, since: this.since, entries: this.entries, holdMs: this.holdMs, reason: this.reason, why, goal, gpu: this.gameMode && this.gpuSeen };
    return this.last;
  }

  info(): StallState { return { ...this.last, entered: false, left: false }; }

  /** When stall mode was last left (ms; -1e12 = never): Auto's looks at the card wait 10 minutes after a stall. */
  get leftAtMs() { return this.leftAt; }

  /** Tests / tools/gamefps_e2e.mjs: stall mode on or off as if judged now (reported by the next step). */
  force(on: boolean, now: number) {
    if (on === this.gameMode) return;
    this.gameMode = on; this.since = on ? now : null; this.reason = on ? 'forced (test)' : ''; this.cleanSince = -1; this.waitSince = -1; this.stallRuns = [];
    this.gpuSeen = on;   // (tests / gamefps_e2e: forced on stands for a game holding the card)
    if (on) this.entries++; else this.leftAt = now;
    this.forced = on ? 'entered' : 'left';
  }

  /** The camera stopped (Tracker.endStall): stall mode off, the next start warms up afresh. The relapse record (entries,
   *  holdMs, leftAt) stays: Auto's no-look-at-the-card rule and the doubling still see the stall. */
  reset(now?: number) {
    if (this.gameMode && now !== undefined) this.leftAt = now;
    this.runs = []; this.healthy = []; this.stallRuns = []; this.firstAt = -1; this.badSince = -1; this.gameSince = -1; this.goodSince = -1; this.cleanSince = -1; this.waitSince = -1; this.gpuSeen = false;
    this.gameMode = false; this.since = null; this.reason = ''; this.forced = '';
    this.last = { ...this.last, gameMode: false, severe: false, hz: 0, ms: 0, entered: false, left: false, since: null, reason: '', why: 'the camera is off', gpu: false };
  }
}
