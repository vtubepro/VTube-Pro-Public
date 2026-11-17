// Where each tracking model runs: the graphics card (GPU) or the processor (CPU), chosen per model.
//
// Why it matters: tasks-vision feeds every input through its own WebGL context and waits on a readback, and all of
// Chrome's WebGL contexts (the studio render, the face worker, the body worker) share one GPU device. While the
// studio and OBS keep the GPU busy, every MediaPipe sync waits behind queued render work. Measured with the real
// pipeline under a heavy render load: face 30 ms (22-28 Hz) on the GPU vs 19 ms (35 Hz) on the CPU, pose 84 vs 60 ms.
// On an idle GPU the GPU wins (face 10-12 ms vs 15 ms). So 'Auto' never assumes: when a model on the GPU stays slow
// while the face falls behind the camera, a replacement worker on the other side is started, warmed and timed on a
// few real frames next to the live one, and it only takes over when it measured faster under the load that is there
// right now (one model at a time, with back-off after a try that did not pay). A model Auto moved to the CPU looks at
// the GPU again 30 s later (sooner when the CPU copy itself is slow: the GPU load that caused the move may be over) and
// goes back only when the GPU is clearly faster; every look that loses doubles the wait (up to 10 minutes), because a
// look starts a GPU worker (model load + shader compile) next to a stream that may be live.
//
// Hands: every model starts on the GPU (as before this file existed: the hand model ran next to pose there). While the
// body side measurably slows a face on the GPU that misses its goal (faceFirst.ts "pressed": measured with probes, not a
// fixed ms mark), Auto first takes the hand model off the GPU ("relieve"): a CPU copy is timed and takes over when it
// still makes 25 results a second (40 ms); the face itself is moved only if it stays starved after that. A relief that
// cannot be taken leaves the face to faceFirst.ts (face-first order, a lower body-side rate). Hands moved to the CPU look
// at the GPU again only while the face meets its goal and is not pressed (same 30 s doubling back-off). Auto judges the
// hand model only while it runs at its full rate (a hand or a wrist in view): at the idle back-off's 4 looks a second its
// timing says nothing about the load it puts next to the face.
//
// The setting (UI: "Tracking processor"): localStorage vtp.trackDelegate = 'auto' (default) | 'gpu' | 'cpu' | 'nogpu'
// ('nogpu' = "Processor (for games)": every model on the processor, pose and hands at most 10 a second. The face on the
// processor runs on src/tracking/cpuFace/, which never touches the graphics card (also for 'cpu' and Auto's moves, unless
// vtp.cpuFace = 'off'); pose and hands stay on tasks-vision's processor path, which still uploads and reads back each
// picture on the graphics card, hence the cap.)
// Same models everywhere: pose keeps the quality preset's model on the CPU too (full on high / ultra, ~46 ms there;
// lite only where the preset picks it), so a move never changes how the body tracks.

import { softGlKnown } from '../stage/gfx/softwareGl.ts';

export type DelegatePolicy = 'auto' | 'gpu' | 'cpu' | 'nogpu';
export type Delegate = 'GPU' | 'CPU';
export type TrackRole = 'face' | 'pose' | 'hands';
export const TRACK_ROLES: readonly TrackRole[] = ['face', 'pose', 'hands'];
export const TRACK_DELEGATE_KEY = 'vtp.trackDelegate';

export function parseDelegatePolicy(v: unknown): DelegatePolicy {
  return v === 'gpu' || v === 'cpu' || v === 'nogpu' ? v : 'auto'; // ('nogpu': cpuFace hook)
}

/** The stored setting ('auto' when nothing / junk is stored, or storage is blocked). Auto on a software GPU (the browser
 *  draws 3D on the processor: src/stage/gfx/softwareGl.ts) means 'cpu': MediaPipe's WebGL path on SwiftShader /
 *  llvmpipe took 500-1000 ms a model there. A stored 'gpu' (the user's choice) still wins. */
export function readDelegatePolicy(softwareGpu = softGlKnown()?.active ?? false): DelegatePolicy {
  let p: DelegatePolicy = 'auto';
  try { p = parseDelegatePolicy(localStorage.getItem(TRACK_DELEGATE_KEY)); } catch { /* blocked storage: auto */ }
  return p === 'auto' && softwareGpu ? 'cpu' : p;
}

/**
 * Where a model starts. Auto: every model on the GPU (measured on an idle GPU: hands 15-19 ms there against 35-37 ms on a
 * 16-core CPU, i.e. fewer and later hand results; a busy GPU is measured and relieved by Auto, see AutoDelegate).
 * `gpuBroken`: the GPU failed to start a model before (no WebGL2 / blocklisted driver): everything starts on the CPU.
 * (`threads` is kept for callers; the start no longer depends on it.)
 */
export function startDelegate(_role: TrackRole, policy: DelegatePolicy, _threads: number, gpuBroken = false): { d: Delegate; why: string } {
  if (gpuBroken) return { d: 'CPU', why: 'GPU unavailable' };
  if (policy === 'cpu') return { d: 'CPU', why: 'setting: processor' };
  if (policy === 'nogpu') return { d: 'CPU', why: 'setting: processor (for games)' }; // cpuFace hook
  return { d: 'GPU', why: '' };
}

export const AUTO = {
  /** face on the GPU slower than this (~1.3 x the face model's CPU cost, ~14 ms) while starved: try the CPU */
  faceSlowMs: 18,
  /** "busy" face: over ~the face model's CPU cost (14-15 ms here; 8-10 ms on an idle GPU). A pose / hands move that leaves
   *  the face under this is not refused for slowing it (measured: hands back on an idle GPU took the face 8.3 -> 10.9 ms,
   *  +31 %, at 47 of 47 a second, and the 15 % check alone kept them on the CPU at 19-27 ms instead of 10) */
  faceBusyMs: 14,
  /** pose on the GPU slower than this while the face is starved: try the CPU (same model; it moves only if faster there) */
  poseSlowMs: 45,
  /** hands slower than this on either side (no longer good for 25 results a second): try the other side. (Measured: hands at
   *  41-44 ms on a busy CPU stayed under a 45 ms rule and ran at ~21 Hz, while the GPU gave them 26 Hz.) */
  handsSlowMs: 40,
  /** hands this slow (under ~17 results a second) only need verySlowSustainMs before the other side is tried */
  handsVerySlowMs: 60,
  verySlowSustainMs: 1500,
  /** "starved": face results per second below this share of the camera frame rate */
  starved: 0.8,
  /** a slow reading has to hold this long */
  sustainMs: 3000,
  /** frames a candidate is timed on next to the live worker (the first one is not counted: one-off allocations) */
  probeFrames: 6,
  /** a candidate that got no frames this long after it was ready is judged on what it has */
  probeTimeoutMs: 6000,
  /** face / pose on the CPU: the first look at the GPU this long after the move (sooner when the CPU copy is slow), then
   *  twice as long after every look that lost, up to maxGpuProbeMs */
  gpuProbeMs: 30000,
  maxGpuProbeMs: 600000,
  /** after a switch: no other try for that model for this long */
  settleMs: 10000,
  /** after a try that did not pay: wait this long (doubling per failure, up to maxBackoffMs) */
  backoffMs: 30000,
  maxBackoffMs: 300000,
  /** a candidate takes over when it measured below (live ms x this): GPU to CPU, back to the GPU (clearly faster), hands */
  toCpu: 0.9,
  toGpu: 0.75,
  hands: 0.8,
  /** hands back on the GPU (a look) and then relieved again within this long: the look did not hold up (its wait doubles) */
  relieveRegretMs: 60000,
};

/** What Auto needs to know about one running model (null = not running / not measured yet). */
export interface RoleView { delegate: Delegate; ms: number }

export interface AutoInput {
  now: number;
  policy: DelegatePolicy;
  /** camera frames per second (measured or the track's setting, 10..60) */
  camFps: number;
  /** face results per second */
  faceHz: number;
  face: RoleView | null;
  pose: RoleView | null;
  hands: RoleView | null;
  /** the GPU cannot start models (never offer it) */
  gpuBroken: boolean;
  /** the adaptive quality ladder reached its "move to the processor" step: try a slow GPU model now */
  kick?: boolean;
  /** faceFirst.ts: the body side measurably slows a face that misses its goal (the hands relief acts on this) */
  pressed?: boolean;
  /** the face meets its goal (faceFirst.ts faceGoalHz; default: not starved) */
  faceOk?: boolean;
  /** the graphics card is known to be busy (the helper's GPU telemetry, shared/gpuStat.ts): no looks at it now */
  noGpuLook?: boolean;
}

/** A try: start `role` on `to`, time it on `probe` frames, switch when it measured below live ms x `factor` (or below
 *  `limit` ms, when that is set and higher) (probe 0 = switch as soon as it is ready: a setting the user chose).
 *  'relieve': the hand model off a GPU the starved face needs; it may cost more ms on the CPU, it only has to stay
 *  under `limit` (still good for 25 results a second). */
export interface AutoTry { role: TrackRole; to: Delegate; why: string; probe: number; factor: number; limit?: number; kind: 'slow' | 'gpuProbe' | 'regret' | 'setting' | 'relieve' | 'stall' }

/** Stall mode (stallGuard.ts; research/tracking_gpu_rca/RCA.md P2): a try that ignores Auto's back-off. The face: to
 *  the processor, fed EVERY camera frame (Tracker.submit) with its results used as they come, switching after 3 timed
 *  results under 0.7 x the stalled worker's time (its in-flight age counts). `probe` 0 = no timing (the body side's
 *  moves after the face, and a worker that has not answered for 10 s). */
export const STALL_TRY = (why: string, probe = 4, role: TrackRole = 'face', to: Delegate = 'CPU'): AutoTry => ({ role, to, why, probe, factor: probe > 0 ? 0.7 : Infinity, kind: 'stall' });
/** After a stall-mode move: the first look at the graphics card this long after it (then doubling per look that lost);
 *  Tracker also holds every look for 10 minutes after the last stall and while the studio is unfocused after one. */
export const STALL_GPU_LOOK_MS = 120000;

export class AutoDelegate {
  /** since when each model has been slow (-1 = it is not) */
  private slowSince: Record<TrackRole, number> = { face: -1, pose: -1, hands: -1 };
  private notBefore: Record<TrackRole, number> = { face: 0, pose: 0, hands: 0 };
  private backoff: Record<TrackRole, number> = { face: AUTO.backoffMs, pose: AUTO.backoffMs, hands: AUTO.backoffMs };
  private gpuProbeAt: Record<TrackRole, number> = { face: 0, pose: 0, hands: 0 };
  /** Wait between two GPU looks of a model on the CPU: gpuProbeMs after a move, doubled by every look that lost. */
  private probeGap: Record<TrackRole, number> = { face: AUTO.gpuProbeMs, pose: AUTO.gpuProbeMs, hands: AUTO.gpuProbeMs };
  /** After Auto moved a model because it was slow: its ms on the side it left (0 = nothing to compare with), and since
   *  when it has been slower than that (-1 = it is not). A probe can be fooled by a moment's load; this undoes a move
   *  that did not hold up within seconds instead of waiting for the once-a-minute GPU look. */
  private leftMs: Record<TrackRole, number> = { face: 0, pose: 0, hands: 0 };
  private regretSince: Record<TrackRole, number> = { face: -1, pose: -1, hands: -1 };
  private movedAt: Record<TrackRole, number> = { face: 0, pose: 0, hands: 0 };
  /** When a GPU look last won (the model went back to the GPU): a relief soon after means that look did not hold up. */
  private lookWonAt: Record<TrackRole, number> = { face: -1e12, pose: -1e12, hands: -1e12 };
  /** Since when the body side has pressed a GPU face with the hand model on the GPU too (-1 = it has not). */
  private relieveSince = -1;

  /** Called a couple of times a second: the next try, or null. */
  decide(i: AutoInput): AutoTry | null {
    const views: Record<TrackRole, RoleView | null> = { face: i.face, pose: i.pose, hands: i.hands };
    if (i.policy !== 'auto') {
      // a setting: move whatever does not run where it says (no timing: the user chose)
      const to: Delegate = i.policy === 'gpu' ? 'GPU' : 'CPU';
      if (to === 'GPU' && i.gpuBroken) return null;
      for (const r of TRACK_ROLES) {
        const v = views[r];
        if (v && v.delegate !== to && i.now >= this.notBefore[r]) return { role: r, to, why: to === 'CPU' ? (i.policy === 'nogpu' ? 'setting: processor (for games)' : 'setting: processor') : '', probe: 0, factor: Infinity, kind: 'setting' };
      }
      return null;
    }
    // (0 results a second is the most starved of all: the old `faceHz > 0` test let a face that had stopped altogether
    //  read as not starved, so it was never moved — game mode, stallGuard.ts, now catches that case on the wall clock too)
    const starved = i.faceHz < AUTO.starved * i.camFps;
    // (face / pose: slow on either side while the face is starved; on the CPU that only brings the GPU look forward)
    for (const r of TRACK_ROLES) {
      const v = views[r];
      const slow = !!v && (r === 'hands' ? v.ms > AUTO.handsSlowMs : starved && v.ms > (r === 'face' ? AUTO.faceSlowMs : AUTO.poseSlowMs));
      if (!slow) this.slowSince[r] = -1;
      else if (this.slowSince[r] < 0) this.slowSince[r] = i.now;
    }
    // relieve: the body side presses the face on the GPU (faceFirst.ts: measured, and the face misses its goal), the face
    // slow or pressed for 3 s (or the ladder's kick), while the hand model runs there too -> time the hand model on the CPU
    // first; the face keeps the GPU's speed when that is enough, and its own move (below) waits for the outcome. The CPU
    // copy takes over when it stays good for 25 a second (or is faster anyway). No relief possible (the processor could
    // not take the hands): faceFirst.ts keeps the face first (order, a lower body-side rate) for as long as the cost is
    // there, and no longer. (The 3 s count from when the face got slow or pressed, whichever came first: faceFirst.ts
    // measures the press with short probes, ~2 s under load, so the relief still comes before the face's own move.)
    {
      const hv = views.hands, fv = views.face;
      const strained = !!hv && hv.delegate === 'GPU' && !!fv && fv.delegate === 'GPU' && (!!i.pressed || this.slowSince.face >= 0);
      if (!strained) this.relieveSince = -1;
      else if (this.relieveSince < 0) this.relieveSince = i.now;
      const held = strained && !!i.pressed && (i.now - this.relieveSince >= AUTO.sustainMs || (!!i.kick && starved));
      if (held && i.now >= this.notBefore.hands) {
        return { role: 'hands', to: 'CPU', why: `auto: hands off the busy GPU (face ${fv!.ms.toFixed(0)} ms)`, probe: AUTO.probeFrames, factor: AUTO.hands, limit: AUTO.handsSlowMs, kind: 'relieve' };
      }
    }
    for (const r of TRACK_ROLES) {
      const v = views[r];
      if (!v || i.now < this.notBefore[r]) continue;
      if (r !== 'hands' && v.delegate === 'CPU') continue; // (the GPU look below, backed off)
      const to: Delegate = v.delegate === 'GPU' ? 'CPU' : 'GPU';
      if (to === 'GPU' && i.gpuBroken) continue;
      const need = r === 'hands' && v.ms > AUTO.handsVerySlowMs ? AUTO.verySlowSustainMs : AUTO.sustainMs;
      const sustained = this.slowSince[r] >= 0 && i.now - this.slowSince[r] >= need;
      const kicked = !!i.kick && r !== 'hands' && v.delegate === 'GPU' && starved;
      if (!sustained && !kicked) continue;
      const why = r === 'hands' ? `auto: hands ${v.ms.toFixed(0)} ms on the ${v.delegate}` : `auto: GPU busy (${r} ${v.ms.toFixed(0)} ms)`;
      return { role: r, to, why, probe: AUTO.probeFrames, factor: r === 'hands' ? AUTO.hands : to === 'CPU' ? AUTO.toCpu : AUTO.toGpu, kind: 'slow' };
    }
    // a move that did not hold up: slower than on the side it left (by 10 %) for 3 s -> time the other side again
    for (const r of TRACK_ROLES) {
      const v = views[r], left = this.leftMs[r];
      if (!v || !left || v.ms <= left * 1.1) { this.regretSince[r] = -1; continue; }
      if (this.regretSince[r] < 0) this.regretSince[r] = i.now;
      const to: Delegate = v.delegate === 'GPU' ? 'CPU' : 'GPU';
      // (not the 10 s settle after a switch: 5 s for the average to reflect the new side, then the 3 s rule)
      if (i.now - this.regretSince[r] < AUTO.sustainMs || i.now - this.movedAt[r] < 5000 || (to === 'GPU' && i.gpuBroken)) continue;
      return { role: r, to, why: `auto: ${r} ${v.ms.toFixed(0)} ms on the ${v.delegate}, was ${left.toFixed(0)} ms`, probe: AUTO.probeFrames, factor: AUTO.toCpu, kind: 'regret' };
    }
    // a model on the CPU: a look at the GPU probeGap after the move (30 s, then doubling per look that lost, up to
    // 10 min). Face / pose: the first look comes sooner (once the settle is over) when the CPU copy has itself been slow
    // for 3 s while the face is starved: the GPU load that caused the move may be gone, and the old GPU figure the regret
    // rule compares with was measured under that load. Hands: only while the face meets its goal and the body side does not
    // press it (a busy GPU: the look would lose, and starting its worker would stall the face once more).
    const faceOk = (i.faceOk ?? !starved) && !i.pressed;
    if (!i.gpuBroken && !i.noGpuLook) for (const r of TRACK_ROLES) {
      const v = views[r];
      if (!v || v.delegate !== 'CPU') { this.gpuProbeAt[r] = 0; continue; }
      if (!this.gpuProbeAt[r]) this.gpuProbeAt[r] = i.now + this.probeGap[r];
      if (r === 'hands' && !faceOk) continue;
      const early = r !== 'hands' && this.probeGap[r] <= AUTO.gpuProbeMs && this.slowSince[r] >= 0 && i.now - this.slowSince[r] >= AUTO.sustainMs;
      if ((i.now >= this.gpuProbeAt[r] || early) && i.now >= this.notBefore[r]) {
        this.gpuProbeAt[r] = i.now + this.probeGap[r];
        return { role: r, to: 'GPU', why: '', probe: AUTO.probeFrames, factor: AUTO.toGpu, kind: 'gpuProbe' };
      }
    }
    return null;
  }

  /** ms until the next GPU look of a model on the CPU (diagnostics / tests; 0 = none planned). */
  nextGpuLook(r: TrackRole, now: number) { return this.gpuProbeAt[r] ? Math.max(0, this.gpuProbeAt[r] - now) : 0; }

  /** Per model: ms until Auto may try it again, its current back-off and the next look at the card (diagnostics:
   *  Tracker.autoState, state.json). */
  state(now: number) {
    const o: Record<string, { waitMs: number; backoffMs: number; nextLookMs: number }> = {};
    for (const r of TRACK_ROLES) o[r] = { waitMs: Math.max(0, Math.round(this.notBefore[r] - now)), backoffMs: this.backoff[r], nextLookMs: Math.round(this.nextGpuLook(r, now)) };
    return o;
  }

  /** A try ended: `switched` = the candidate took over; `liveMs` = the replaced worker's ms (for the regret check). */
  done(t: AutoTry, switched: boolean, now: number, liveMs = 0) {
    const r = t.role;
    this.slowSince[r] = -1;
    this.regretSince[r] = -1;
    if (t.kind === 'relieve' && switched) this.relieveSince = -1;
    // remember what the model cost where it was when a slow reading moved it; any other outcome ends the comparison
    this.leftMs[r] = switched && t.kind === 'slow' ? liveMs : t.kind === 'slow' ? this.leftMs[r] : 0;
    if (switched) this.movedAt[r] = now;
    if (switched && t.kind === 'stall') {
      // game mode: no regret comparison with the starved figure, the first look at the card in 2 minutes
      this.leftMs[r] = 0; this.regretSince[r] = -1; this.movedAt[r] = now;
      this.backoff[r] = AUTO.backoffMs;
      this.notBefore[r] = now + AUTO.settleMs;
      this.probeGap[r] = Math.max(this.probeGap[r], STALL_GPU_LOOK_MS);
      this.gpuProbeAt[r] = now + this.probeGap[r];
      return;
    }
    if (switched) {
      this.backoff[r] = AUTO.backoffMs;
      this.notBefore[r] = now + AUTO.settleMs;
      // the wait to the next GPU look: 30 s after a move to the CPU; a look that won keeps its wait; hands relieved again
      // within a minute of a look that brought them back: that look did not hold up (twice as long to the next one)
      if (t.kind === 'relieve' && now - this.lookWonAt[r] < AUTO.relieveRegretMs) this.probeGap[r] = Math.min(AUTO.maxGpuProbeMs, this.probeGap[r] * 2);
      else if (t.kind !== 'gpuProbe') this.probeGap[r] = AUTO.gpuProbeMs;
      if (t.kind === 'gpuProbe') this.lookWonAt[r] = now;
      this.gpuProbeAt[r] = now + this.probeGap[r];
      // (after a relief the face's own move waits another sustainMs: long enough to see what the relief did)
      if (t.kind === 'relieve') this.slowSince.face = -1;
    } else if (t.kind === 'slow' || t.kind === 'relieve') {
      this.notBefore[r] = now + this.backoff[r];
      this.backoff[r] = Math.min(AUTO.maxBackoffMs, this.backoff[r] * 2);
    } else if (t.kind === 'gpuProbe') {
      // a GPU look that lost (or failed to start): twice as long to the next one, up to 10 minutes
      this.probeGap[r] = Math.min(AUTO.maxGpuProbeMs, this.probeGap[r] * 2);
      this.gpuProbeAt[r] = now + this.probeGap[r];
    } else if (t.kind === 'setting' || t.kind === 'stall') this.notBefore[r] = now + AUTO.settleMs; // (it failed to start: not in a loop)
  }

  /** Forget timers (a new session / settings change). */
  reset() {
    for (const r of TRACK_ROLES) {
      this.slowSince[r] = -1; this.notBefore[r] = 0; this.backoff[r] = AUTO.backoffMs; this.gpuProbeAt[r] = 0; this.probeGap[r] = AUTO.gpuProbeMs;
      this.leftMs[r] = 0; this.regretSince[r] = -1; this.lookWonAt[r] = -1e12;
    }
    this.relieveSince = -1;
  }
}

/** Median of a list (0 for an empty one). */
export function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
