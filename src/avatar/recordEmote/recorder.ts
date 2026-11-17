// "Record my own emote" (lane recemote): after a 3-2-1 countdown, copy the avatar's solved pose (head, spine, arms, hands,
// fingers) into a take, 24 times a second, until Stop or the time limit. Nothing runs before Record is pressed or after it ends,
// and nothing is allocated per frame (the buffers are made once, for the longest take).
//
// The pose is read from the avatar's own humanoid bones, i.e. exactly what tracking solved (not the camera picture, not raw
// landmarks), so a recording looks like what the audience saw. Eyes and jaw are left out: gaze, blinks and lip sync stay live.
import type { VRMHumanoid } from '@pixiv/three-vrm';
import { CLIP_MAX_FPS, CLIP_MAX_SECS, CLIP_MIN_FRAMES, type Take } from './clip.ts';
import { buildRig, recordableBones, sampleRig, type Rig } from './rig.ts';

/** Recording rate: smooth enough for hands, and a 30 s take stays well under 1 MB. */
export const RECORD_FPS = 24;

export interface RecorderHost {
  runtime: { humanoid: VRMHumanoid | null; vrm: { meta?: { metaVersion?: string } } | null } | null;
  trackingOn: boolean;
  frame: { tracked: boolean };
  stopEmote(): void;
}
export type RecorderPhase = 'idle' | 'countdown' | 'recording';
export interface RecorderEvents {
  /** 3, 2, 1 while counting down */
  onCount?(n: number): void;
  /** about every 100 ms while recording */
  onProgress?(secs: number, maxSecs: number): void;
  onDone(take: Take, info: { lostFraction: number }): void;
  onError(text: string): void;
}
export interface RecorderOptions { maxSecs: number; countdown?: number; fps?: number }

/** Why Record cannot start right now, in plain words (null = go ahead). */
export function recordBlocker(host: RecorderHost): string | null {
  if (!host.runtime) return 'Load a 3D avatar first.';
  if (!host.runtime.humanoid) return 'This avatar has no body bones, so it cannot play emotes. Try a 3D humanoid avatar.';
  if (!host.trackingOn) return 'Turn your camera on first (Tracking) so I can see you move.';
  return null;
}

export class TakeRecorder {
  phase: RecorderPhase = 'idle';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private raf = 0;
  private rig: Rig | null = null;
  private buf: Record<string, Float32Array> = {};
  private n = 0;
  private lost = 0;
  private t0 = 0;
  private maxFrames = 0;
  private fps = RECORD_FPS;
  private rt: RecorderHost['runtime'] = null;
  private ev: RecorderEvents | null = null;
  private opt: RecorderOptions | null = null;
  private host: RecorderHost | null = null;
  private lastProgress = 0;

  start(host: RecorderHost, opt: RecorderOptions, ev: RecorderEvents): boolean {
    if (this.phase !== 'idle') return false;
    const why = recordBlocker(host);
    if (why) { ev.onError(why); return false; }
    this.host = host; this.ev = ev; this.opt = opt; this.rt = host.runtime;
    host.stopEmote();                                     // a playing emote would be recorded as part of the pose
    this.phase = 'countdown';
    const count = Math.max(0, Math.floor(opt.countdown ?? 3));
    const tick = (k: number) => {
      if (this.phase !== 'countdown') return;
      if (k <= 0) { this.begin(); return; }
      ev.onCount?.(k);
      this.timer = setTimeout(() => tick(k - 1), 1000);
    };
    tick(count);
    return true;
  }

  private begin() {
    const host = this.host!, opt = this.opt!;
    const hum = host.runtime?.humanoid;
    if (!hum || host.runtime !== this.rt) { this.fail('The avatar changed, so the recording was cancelled.'); return; }
    this.rig = buildRig(hum, host.runtime!.vrm?.meta?.metaVersion === '0');
    this.fps = Math.max(5, Math.min(CLIP_MAX_FPS, opt.fps ?? RECORD_FPS));
    const secs = Math.max(1, Math.min(CLIP_MAX_SECS, opt.maxSecs));
    this.maxFrames = Math.floor(secs * this.fps) + 1;
    this.buf = {};
    for (const b of recordableBones(this.rig)) this.buf[b] = new Float32Array(this.maxFrames * 4);
    this.n = 0; this.lost = 0; this.lastProgress = 0;
    this.phase = 'recording';
    this.t0 = performance.now();
    this.raf = requestAnimationFrame(this.step);
  }

  private step = () => {
    if (this.phase !== 'recording') return;
    const host = this.host!;
    if (host.runtime !== this.rt || !host.runtime?.humanoid) { this.fail('The avatar changed, so the recording was cancelled.'); return; }
    const now = performance.now();
    // one sample per frame slot that is due (a slow frame never leaves a gap: it repeats the current pose)
    const due = Math.min(this.maxFrames, Math.floor(((now - this.t0) / 1000) * this.fps) + 1);
    while (this.n < due) {
      sampleRig(this.rig!, this.buf, this.n);
      if (!host.frame.tracked) this.lost++;
      this.n++;
    }
    if (now - this.lastProgress >= 100) { this.lastProgress = now; this.ev!.onProgress?.((this.n - 1) / this.fps, (this.maxFrames - 1) / this.fps); }
    if (this.n >= this.maxFrames) { this.finish(); return; }
    this.raf = requestAnimationFrame(this.step);
  };

  /** Stop and hand over what was recorded so far. */
  stop() {
    if (this.phase === 'recording') this.finish();
    else if (this.phase === 'countdown') this.cancel();
  }
  /** Throw the recording away. */
  cancel() {
    if (this.phase === 'idle') return;
    this.reset();
  }

  private finish() {
    const ev = this.ev!, n = this.n, lost = this.lost;
    const bones: Record<string, Float32Array> = {};
    for (const [b, q] of Object.entries(this.buf)) bones[b] = q.slice(0, n * 4);
    const fps = this.fps;
    this.reset();
    if (n < CLIP_MIN_FRAMES + 3) { ev.onError('That was too short. Hold Record a little longer and move.'); return; }
    ev.onDone({ fps, frames: n, bones }, { lostFraction: n ? lost / n : 0 });
  }
  private fail(text: string) { const ev = this.ev; this.reset(); ev?.onError(text); }
  private reset() {
    if (this.timer) clearTimeout(this.timer);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.timer = null; this.raf = 0;
    this.phase = 'idle';
    this.rig = null; this.buf = {}; this.host = null; this.rt = null; this.opt = null; this.ev = null; this.n = 0; this.lost = 0;
  }
}
