// The face tracker's ordered fallback chain (lane #190):
//
//   1. MediaPipe on the graphics card        (the default; Tracker.ts / delegatePolicy.ts)
//   2. MediaPipe on the processor            (tasks-vision's CPU delegate, or src/tracking/cpuFace/ when the card is busy)
//   3. OpenSeeFace on the processor          (src/tracking/openSeeFace/: two small networks, WebAssembly, no card at all)
//
// Steps 1 -> 2 are the Tracker's own business (Auto delegate, stall mode, a failed GPU start): this module WATCHES them, says
// them in one plain sentence, and takes the last step: when no MediaPipe path starts (init failure) or the processor path cannot
// keep up (results far below the camera's rate for several seconds, or a run stuck for seconds) it asks for OpenSeeFace, or,
// when that is not installed yet, offers the 5 MB download once. It never switches back by itself (a tracker that flips between
// two engines every minute is worse than either); "Try the better tracker again" is the user's button.
//
// Pure: fed one reading every ~500 ms, answers with at most one action (tools/face_chain_unit.ts).

export type FaceTier = 'mediapipe-gpu' | 'mediapipe-cpu' | 'openseeface';
export type ChainPolicy = 'auto' | 'gpu' | 'cpu' | 'nogpu';
export interface ChainReading {
  /** performance.now() in ms */
  now: number;
  /** the camera is open and the tracker has been started */
  trackingOn: boolean;
  /** frames a second the camera delivers (0 = unknown) */
  camFps: number;
  /** where the MediaPipe face runs now ('' = no face model running) */
  faceDelegate: 'GPU' | 'CPU' | '';
  /** face results a second MediaPipe delivers now */
  faceHz: number;
  /** ms the current face run has been going without a result (0 = none in flight) */
  faceInFlightMs: number;
  /** the Tracker could not start any face path (the message of its error) */
  initError?: string;
  /** why the face is on the processor, when it is (the Tracker's own words, shown only as a hint) */
  cpuReason?: string;
  /** the Tracking processor setting */
  policy: ChainPolicy;
  /** OpenSeeFace: models installed? (null = not asked yet), and whether its tracker is running / how fast */
  osf: { installed: boolean | null; running: boolean; hz: number };
}

export type ChainAction =
  | { kind: 'say'; level: 'info' | 'warn'; text: string; tier: FaceTier }
  | { kind: 'use-openseeface'; text: string; tier: FaceTier; why: 'init' | 'slow' | 'stuck' }
  | { kind: 'offer-openseeface'; text: string; tier: FaceTier };

export const CHAIN = {
  /** no judgement in the first seconds after the camera starts (model load, warm-up) */
  armMs: 5000,
  /** the processor face is "too slow" below this many results a second ... */
  minHz: 10,
  /** ... while the camera delivers at least this many frames a second ... */
  camMinFps: 12,
  /** ... for this long */
  slowMs: 7000,
  /** one run in flight this long without a result */
  stuckMs: 4000,
  /** the offer to install is repeated at most this often */
  offerEveryMs: 10 * 60 * 1000,
  /** the same sentence is not said twice within this */
  sayEveryMs: 60 * 1000,
} as const;

export const SENTENCE = {
  gpuToCpu: 'Face tracking moved to your processor because the graphics card was too busy for it.',
  gpuFailed: 'Face tracking is running on your processor because the graphics card could not start it.',
  osfInit: 'Your usual face tracker would not start on this PC, so the light face tracker is following your face instead.',
  osfSlow: 'Face tracking was too slow on this PC, so the light face tracker is following your face instead.',
  osfStuck: 'Face tracking stopped answering, so the light face tracker is following your face instead.',
  offer: 'Face tracking is too slow on this PC. A lighter tracker (5 MB) can follow your face instead: get it once and it switches on by itself.',
  offerInit: 'Face tracking would not start on this PC. A lighter tracker (5 MB) can follow your face instead: get it once and it starts by itself.',
  explicitSlow: 'Face tracking is slow with the processor setting you chose. The light face tracker can follow your face instead: you can switch to it in the Tracking panel.',
  osfFailed: 'Your usual face tracker keeps following your face.',
  osfRestoreFailed: 'The usual face tracker could not start again, so the light face tracker keeps following your face.',
  osfSlowToo:'The light face tracker is slow too. Close other programs that use the processor, or lower the camera’s resolution.',
} as const;

export class FaceChain {
  tier: FaceTier = 'mediapipe-gpu';
  /** what the user was last told (for the status line) */
  lastText = '';
  private armedAt = 0;
  private slowSince = 0;
  private stuckSince = 0;
  private osfSlowSince = 0;
  private told = new Map<string, number>();
  private offeredAt = -Infinity;
  private suggestedAt = -Infinity;
  private seenTier: FaceTier | null = null;
  private osfRequested = false;
  private osfSaidSlow = false;

  /** Forget a run (camera stopped / restarted); the chain starts again from MediaPipe. */
  reset() {
    this.tier = 'mediapipe-gpu'; this.armedAt = 0; this.slowSince = 0; this.stuckSince = 0; this.osfSlowSince = 0;
    this.seenTier = null; this.osfRequested = false; this.osfSaidSlow = false; this.lastText = '';
  }
  /** "Try the better tracker again": the chain goes back to MediaPipe (the app restarts the tracker). */
  retryMediaPipe() { this.reset(); this.told.clear(); }

  private say(key: string, now: number, a: ChainAction): ChainAction | null {
    const last = this.told.get(key);
    if (last !== undefined && now - last < CHAIN.sayEveryMs) return null;
    this.told.set(key, now);
    if ('text' in a) this.lastText = a.text;
    return a;
  }

  step(r: ChainReading): ChainAction | null {
    if (!r.trackingOn) { this.armedAt = 0; this.slowSince = 0; this.stuckSince = 0; this.osfSlowSince = 0; return null; }
    if (!this.armedAt) this.armedAt = r.now;

    // ---- an init failure is answered at once (no arming: nothing is running to wait for)
    if (r.initError !== undefined && !this.osfRequested) return this.towardOsf(r, 'init');

    // ---- OpenSeeFace is on: only watch that it is not slow too
    if (this.tier === 'openseeface' || r.osf.running) {
      this.tier = 'openseeface';
      if (r.osf.running && r.now - this.armedAt > CHAIN.armMs) {
        if (r.osf.hz < 8 && (r.camFps === 0 || r.camFps >= CHAIN.camMinFps)) {
          this.osfSlowSince ||= r.now;
          if (!this.osfSaidSlow && r.now - this.osfSlowSince > CHAIN.slowMs * 1.5) { this.osfSaidSlow = true; return this.say('osf-slow', r.now, { kind: 'say', level: 'warn', text: SENTENCE.osfSlowToo, tier: this.tier }); }
        } else this.osfSlowSince = 0;
      }
      return null;
    }

    // ---- which MediaPipe tier is it? say a change the Tracker made on its own
    const tier: FaceTier = r.faceDelegate === 'CPU' ? 'mediapipe-cpu' : 'mediapipe-gpu';
    let out: ChainAction | null = null;
    if (r.faceDelegate && this.seenTier && tier !== this.seenTier && tier === 'mediapipe-cpu') {
      out = this.say('gpu-cpu', r.now, { kind: 'say', level: 'info', tier, text: SENTENCE.gpuToCpu });
    } else if (r.faceDelegate && !this.seenTier && tier === 'mediapipe-cpu' && /graphics|GPU|WebGL/i.test(r.cpuReason ?? '')) {
      out = this.say('gpu-failed', r.now, { kind: 'say', level: 'info', tier, text: SENTENCE.gpuFailed });
    }
    if (r.faceDelegate) { this.seenTier = tier; this.tier = tier; }
    if (r.now - this.armedAt < CHAIN.armMs) return out;

    // ---- the processor tier cannot keep up -> OpenSeeFace (a graphics-card tier that is slow is the Tracker's to move first)
    const camOk = r.camFps === 0 || r.camFps >= CHAIN.camMinFps;
    const onCpu = tier === 'mediapipe-cpu' || r.policy === 'cpu' || r.policy === 'nogpu';
    const slow = !!r.faceDelegate && onCpu && camOk && r.faceHz < CHAIN.minHz;
    this.slowSince = slow ? this.slowSince || r.now : 0;
    const stuck = !!r.faceDelegate && onCpu && r.faceInFlightMs > CHAIN.stuckMs;
    this.stuckSince = stuck ? this.stuckSince || r.now : 0;
    const bad = stuck || (slow && r.now - this.slowSince >= CHAIN.slowMs);
    if (!bad) return out;
    // an explicit "Tracking processor" choice (processor / processor for games / graphics card) is the user's, not ours to
    // override: say it once in a while and point at the button, never switch by ourselves
    if (r.policy !== 'auto') {
      if (r.now - this.suggestedAt < CHAIN.offerEveryMs) return out;
      this.suggestedAt = r.now;
      this.lastText = SENTENCE.explicitSlow;
      return { kind: 'say', level: 'warn', text: SENTENCE.explicitSlow, tier: this.tier };
    }
    return this.towardOsf(r, stuck ? 'stuck' : 'slow') ?? out;
  }

  /** Step 3: use OpenSeeFace if it is installed, else offer it (rarely). */
  private towardOsf(r: ChainReading, why: 'init' | 'slow' | 'stuck'): ChainAction | null {
    if (r.osf.installed) {
      this.osfRequested = true; this.tier = 'openseeface';
      const text = why === 'init' ? SENTENCE.osfInit : why === 'slow' ? SENTENCE.osfSlow : SENTENCE.osfStuck;
      this.lastText = text;
      return { kind: 'use-openseeface', why, text, tier: 'openseeface' };
    }
    if (r.osf.installed === null) return null;           // not asked yet: ask VTube Pro first
    if (r.now - this.offeredAt < CHAIN.offerEveryMs) return null;
    this.offeredAt = r.now;
    const text = why === 'init' ? SENTENCE.offerInit : SENTENCE.offer;
    this.lastText = text;
    return { kind: 'offer-openseeface', text, tier: this.tier };
  }
}
