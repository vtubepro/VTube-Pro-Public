// Face first: the face model drives lip sync, so it keeps its rate when the body-side models (pose, hands) share the
// graphics card with it under load (OBS + the studio render). Measured on the real pipeline under a heavy GPU load with
// hands up: three models in flight at once (face, pose, hands in their own workers) took the face from 29 to 26 a second
// on a 30 fps camera (14-17 -> 19-22 ms), where one body worker running pose and hands one after the other did not.
//
// Two levers, used only while the body side MEASURABLY slows a face that misses its goal ("pressed"; the goal: the
// camera's rate up to 45 results a second, and under 18 ms a result, where the tracker's mouth reads still run):
//  - order: a body-side frame is not started while the face has a frame in flight; it goes the moment the face result
//    lands (the face's GPU work no longer queues behind pose / hand work that started next to it)
//  - rate: the body-side frame rate steps down (x 0.85 every half second, to half) until the body side costs the face no
//    more than 8 % of its clean time, and climbs back (+5 % every half second) once it does not.
// The cost is measured, never assumed (a machine-specific "busy face" number held the hands at half rate for whole
// streams on 60 fps cameras; later an "overlap alone counts as a cost" rule did much the same). A probe holds the body
// side for about two face runs (Tracker: quiet); a face run that starts and ends inside it with no body-side run next
// to it is "clean", the face's own time at that moment. Each clean run is compared with the mean of the face runs of
// the half second before it (the same render load, the body side as it runs); the mean of those differences is what the
// body side costs the face, and it counts only beyond the run-to-run noise. Only probe runs count as clean: a face run
// that happens to miss the body side is one that ended early, so its time says nothing about the cost. A face slow for
// another reason (the render load alone) costs the body side nothing. Probes run while the face misses its goal with
// the body side next to it: at most one a second while a judgement is open, about one in 3-5 s otherwise.

export const FACE_FIRST = {
  /** the face rate above which the body side is never held back (lip sync needs ~30; the camera's rate when slower) */
  goalHz: 45,
  /** ... with this much slack (results land on camera-frame boundaries) */
  goalShare: 0.95,
  /** a face over this many ms (trimmed mean) misses its goal too, whatever its rate: the tracker's mouth reads stop at
   *  20 ms (Teeth & tongue, food & drink: Tracker.mouthActive) and 22 ms (the mouth-visibility patch: mouthVisPause), and
   *  every ms is lip-sync latency. Measured (sim calibrated to the real pipeline): a 30 fps camera keeps 30 a second while
   *  pose + hands next to the face take it from 14 to 21-23 ms. */
  busyMs: 18,
  /** face runs judged (rate, mean, overlap; "fresh" clean runs): the last this many ms */
  windowMs: 3000,
  /** a clean run is compared with the mean of the other face runs of this many ms before it (at least 2 of them) */
  pairMs: 500,
  /** clean runs kept: the newest cleanKeep of the last cleanWindowMs (all runs of it: their spread is the noise) */
  cleanWindowMs: 10000,
  cleanKeep: 8,
  /** results needed in the window, and clean runs kept, before the cost counts as known */
  minSamples: 4,
  /** fresh clean runs (in the window) needed to judge on them; a press is judged on fresh runs only (older ones can clear
   *  the body side, never hold it back) */
  freshClean: 2,
  /** a fresh cost above the allowed share but within the noise: more probes until this many fresh runs decide */
  decideClean: 6,
  /** the body side may cost the face this share of its clean time (and at least minSlowMs) ... */
  maxSlowdown: 0.08,
  minSlowMs: 1,
  /** ... and a cost counts only beyond this many standard errors (the face's run-to-run spread) */
  noiseZ: 3.5,
  /** no clean run to tell while body-side runs overlap more than this share of the face on average: a probe (never a
   *  press). Low: a body side next to a third of the face runs can still make it 25 % slower on average */
  unknownOverlap: 0.1,
  /** probe: body-side frames wait (Tracker: quiet) until probeRuns clean face runs landed, at most probeMs, and at most
   *  once every probeGapMs (5 x that once a judgement has been open unsureMs) */
  probeRuns: 2,
  probeMs: 250,
  probeGapMs: 1000,
  /** a judgement left open this long (no clean run came to measure against) counts as calm: no hold-back on a guess */
  unsureMs: 4000,
  /** body-side rate: never under this share of its preset rate; step down / up per tick */
  floor: 0.5,
  down: 0.85,
  up: 0.05,
  tickMs: 500,
  /** face-first order stays on this long after the last pressed tick (and until the rate is back at full). Under a steady
   *  load the order itself hides the cost it removes, so a short hold cycles (off, pressed again 1-2 s later); 30 s beat
   *  10 s in the contention model (30 fps camera: face p90 20.3 vs 21.6 ms, same hand rate) */
  holdMs: 30000,
};

/** The face rate the body side must not cost (results per second): the camera's rate up to goalHz, with the slack. */
export function faceGoalHz(camFps: number): number {
  return Math.min(camFps, FACE_FIRST.goalHz) * FACE_FIRST.goalShare;
}

/** One clean run against the face runs of its moment (near: their trimmed mean; m: how many). */
interface Look { t: number; ms: number; near: number; m: number }

/**
 * What the body side costs the face now. meanMs / overlap: the window's runs; noiseMs: the run-to-run spread of the
 * last cleanWindowMs (clean and other runs each around their own median). The cost (the mean ms of the runs just
 * before a clean run over that clean run): slowMs over the kept clean runs (null: fewer than minSamples), freshMs over
 * the window's (null: fewer than freshClean), each with its standard error. nearMs: the mean ms just before the kept
 * clean runs.
 */
export interface FaceCost {
  n: number; meanMs: number; overlap: number; noiseMs: number;
  nClean: number; cleanMs: number | null; nearMs: number | null; slowMs: number | null; slowSe: number | null;
  nFresh: number; freshMs: number | null; freshSe: number | null;
}

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
/** mean without the slowest 10 % (one stall, e.g. a garbage collection, is not the body side's cost) */
const trimmedMean = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y), keep = s.slice(0, Math.max(1, Math.ceil(s.length * 0.9)));
  return keep.reduce((x, y) => x + y, 0) / keep.length;
};
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

export class FaceFirst {
  /** body-side rate factor (floor..1): the pose / hand rate caps are multiplied by it */
  scale = 1;
  /** face-first order in effect: body-side frames wait while the face has one in flight */
  active = false;
  /** the last judgement: the body side measurably slows a face that misses its goal (kept while a probe looks) */
  pressed = false;
  /** probes started (diagnostics) */
  probes = 0;
  /** face runs of the last cleanWindowMs, oldest first (clean: a probe run with no body-side run next to it) */
  private s: { t: number; ms: number; ov: number; clean: boolean }[] = [];
  private lastTick = -1e12;
  private calmSince = -1;
  private unsureSince = -1;
  private probeT = -1e12;
  private probeGot = 0;
  private probing = false;

  /** One face result: the face model's ms and the share of its run (send -> result) that body-side runs overlapped. */
  sample(now: number, ms: number, overlap: number) {
    if (!(ms > 0) || !isFinite(ms)) return;
    const ov = Math.min(1, Math.max(0, overlap || 0));
    // (a probe that ran out ends at the tracker's next camera frame: its body-side frames may already be in flight)
    const clean = this.quiet(now) && ov === 0;
    this.s.push({ t: now, ms, ov, clean });
    if (clean) this.probeGot++;
    this.prune(now);
  }

  private prune(now: number) {
    const lim = now - FACE_FIRST.cleanWindowMs;
    let k = 0;
    while (k < this.s.length && this.s[k].t < lim) k++;
    if (k) this.s.splice(0, k);
  }

  /**
   * A probe is on: the tracker starts no body-side frame, so the face runs alone (clean runs to measure against). It ends
   * after probeRuns clean face runs, or after probeMs.
   */
  quiet(now: number): boolean {
    if (this.probing && (this.probeGot >= FACE_FIRST.probeRuns || now - this.probeT >= FACE_FIRST.probeMs)) this.probing = false;
    return this.probing;
  }

  /** The body side's cost to the face (null = too few face results in the window). */
  cost(now: number): FaceCost | null {
    const F = FACE_FIRST;
    this.prune(now);
    const s = this.s, lim = now - F.windowMs;
    let w0 = 0;
    while (w0 < s.length && s[w0].t < lim) w0++;
    const win = s.slice(w0), n = win.length;
    if (n < F.minSamples) return null;
    const meanMs = trimmedMean(win.map((x) => x.ms));
    const overlap = win.reduce((a, x) => a + x.ov, 0) / n;
    // run-to-run spread over all kept runs (cleanWindowMs: 3 s of runs read it 30 % low at times, and a cost then cleared
    // the noise bar by chance): 1.4826 x the median absolute deviation, clean and other runs each around their own median
    // (a cost splits them in two groups; that split is not noise)
    const res = (a: number[]) => { if (!a.length) return []; const m = median(a); return a.map((x) => Math.abs(x - m)); };
    const noiseMs = 1.4826 * median([...res(s.filter((x) => x.clean).map((x) => x.ms)), ...res(s.filter((x) => !x.clean).map((x) => x.ms))]);
    // the newest clean runs, each against the (trimmed) mean of the other runs of the pairMs before it (not other clean
    // ones): what the face took just then with the body side as it ran, over what it takes alone. (Before only: a load
    // that changes right after a probe is not that probe's cost.)
    const looks: Look[] = [];
    for (let j = s.length - 1; j >= 0 && looks.length < F.cleanKeep; j--) {
      const x = s[j];
      if (!x.clean) continue;
      const nb: number[] = [];
      for (let a = j - 1; a >= 0 && x.t - s[a].t <= F.pairMs; a--) if (!s[a].clean) nb.push(s[a].ms);
      if (nb.length >= 2) looks.push({ t: x.t, ms: x.ms, near: trimmedMean(nb), m: nb.length });
    }
    // the cost over a set of looks, and its standard error (each difference: one clean run against a mean of m runs)
    const judge = (l: Look[]) => ({ ms: mean(l.map((x) => x.near - x.ms)), se: noiseMs * Math.sqrt(l.reduce((a, x) => a + 1 + 1 / x.m, 0)) / l.length });
    const fresh = looks.filter((x) => x.t >= lim);
    const f = fresh.length >= F.freshClean ? judge(fresh) : null;
    const base = { n, meanMs, overlap, noiseMs, nClean: looks.length, nFresh: fresh.length, freshMs: f?.ms ?? null, freshSe: f?.se ?? null };
    if (looks.length < F.minSamples) return { ...base, cleanMs: null, nearMs: null, slowMs: null, slowSe: null };
    const k = judge(looks);
    return { ...base, cleanMs: mean(looks.map((x) => x.ms)), nearMs: mean(looks.map((x) => x.near)), slowMs: k.ms, slowSe: k.se };
  }

  /**
   * Called on face results; acts every tickMs. `side`: a body-side model runs on camera frames. Returns true when it
   * judged (a tick), false when it was too soon.
   */
  tick(now: number, i: { faceHz: number; camFps: number; side: boolean }): boolean {
    if (now - this.lastTick < FACE_FIRST.tickMs) return false;
    this.lastTick = now;
    const F = FACE_FIRST;
    const c = i.side && i.faceHz > 0 ? this.cost(now) : null;
    let v: 'pressed' | 'calm' | 'unsure' = 'calm';
    // the face misses its goal: too few results a second, or too slow per result (busyMs)
    if (c && (i.faceHz < faceGoalHz(i.camFps) || c.meanMs > F.busyMs)) {
      // (the share the body side may cost, of the face's own time)
      const allowed = Math.max(F.minSlowMs, F.maxSlowdown * (c.cleanMs ?? c.meanMs));
      if (c.freshMs !== null && c.freshSe !== null) {
        // fresh looks (this window): pressed beyond the share and the noise; within the noise: more looks, then calm
        if (c.freshMs <= allowed) v = 'calm';
        else if (c.freshMs > F.noiseZ * c.freshSe) v = 'pressed';
        else v = c.nFresh < F.decideClean ? 'unsure' : 'calm';
      } else if (c.slowMs !== null && c.nearMs !== null && c.slowSe !== null) {
        // older looks only: they clear the body side unless the face got slower since or they showed a cost (look again)
        v = c.meanMs - c.nearMs > allowed || (c.slowMs > allowed && c.slowMs > F.noiseZ * c.slowSe) ? 'unsure' : 'calm';
      } else if (c.overlap > F.unknownOverlap) v = 'unsure'; // no look yet while the body side sits next to the face
    }
    if (v === 'unsure') {
      if (this.unsureSince < 0) this.unsureSince = now;
      const open = now - this.unsureSince >= F.unsureMs;
      if (!this.probing && now - this.probeT >= (open ? 5 : 1) * F.probeGapMs) {
        this.probing = true; this.probeT = now; this.probeGot = 0; this.probes++;
      }
      if (open) v = 'calm';
    } else this.unsureSince = -1;
    if (v === 'pressed') {
      this.pressed = true;
      this.scale = Math.max(F.floor, this.scale * F.down);
      this.active = true;
      this.calmSince = -1;
    } else if (v === 'calm') {
      this.pressed = false;
      this.scale = Math.min(1, this.scale + F.up);
      if (this.calmSince < 0) this.calmSince = now;
      if (this.active && this.scale >= 1 && now - this.calmSince >= F.holdMs) this.active = false;
    }
    return true;
  }

  /** Forget everything (body side switched off, tracker closed). */
  reset() {
    this.s.length = 0;
    this.scale = 1; this.active = false; this.pressed = false;
    this.lastTick = -1e12; this.calmSince = -1; this.unsureSince = -1;
    this.probeT = -1e12; this.probeGot = 0; this.probing = false;
  }
}
