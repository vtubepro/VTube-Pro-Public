// Face hidden from the face model (a real mask, a hand, a mic in front of the mouth, heavy glare on
// glasses…) but the body model still sees the head: keep the avatar's head alive from the body model's
// head keypoints (nose, eyes, ears), while the voice keeps driving the mouth and idle life keeps the
// eyes blinking. Gains are fitted on the recorded clip against the real face solver
// (tools/fit_pose_head.ts), so the fallback moves the head the same amount the face tracker would.
import type { PoseLandmarkerResult } from '@mediapipe/tasks-vision';
import type { Vec3 } from '../../shared/types.ts';

export interface HeadKeypoints {
  nose: { x: number; y: number };
  eyeL: { x: number; y: number };   // performer's left
  eyeR: { x: number; y: number };
  earL: { x: number; y: number };
  earR: { x: number; y: number };
}

/** Raw (unscaled) yaw / pitch / roll signals from normalised image keypoints. */
export function headFromKeypoints(k: HeadKeypoints, aspect: number, _prev: Vec3 | null): Vec3 | null {
  const ex = (k.earL.x - k.earR.x) * aspect, ey = k.earL.y - k.earR.y;
  const span = Math.hypot(ex, ey);
  if (span < 1e-3) return null;
  const mid = { x: (k.earL.x + k.earR.x) / 2, y: (k.earL.y + k.earR.y) / 2 };
  const eyeMid = { x: (k.eyeL.x + k.eyeR.x) / 2, y: (k.eyeL.y + k.eyeR.y) / 2 };
  const yaw = ((k.nose.x - mid.x) * aspect) / span;          // nose off the ear midline
  const pitch = (k.nose.y - eyeMid.y) / span;                // nose below the eyes (pitch down = bigger)
  const roll = Math.atan2(k.eyeL.y - k.eyeR.y, (k.eyeL.x - k.eyeR.x) * aspect);
  return [yaw, pitch, roll];
}

// fitted gains (tools/fit_pose_head.ts): raw keypoint signal → face-solver radians
// (clip fit: yaw r=0.92, pitch r=0.81, roll r=0.90). Offsets are learned live (OcclusionFallback), since
// they depend on the person and the calibration.
export const POSE_HEAD_FIT = { yaw: { a: 0.892, b: 0 }, pitch: { a: 2.021, b: 0 }, roll: { a: -0.918, b: 0 } };

/**
 * While the face is visible, learn the offset between the face solver's head and the keypoint estimate;
 * when the face disappears, keep the head moving from the keypoints (+ that offset) so the switch is
 * seamless. `head` / returned values are FINAL frame convention (relative to rest, mirrored as tuned).
 */
export class OcclusionFallback {
  private off: Vec3 = [0, 0, 0];
  private learned = 0;
  private sm: Vec3 | null = null;
  /** Seconds the face has been hidden while the fallback drove the head. */
  hiddenFor = 0;

  step(tracked: boolean, head: Vec3, pose: PoseLandmarkerResult | null, aspect: number, mirror: boolean, scale: number, dt: number): Vec3 | null {
    const raw = headFromPose(pose, aspect);
    if (!raw) { this.sm = null; if (!tracked) this.hiddenFor += dt; return null; }
    const m = mirror ? [-scale, scale, -scale] : [scale, scale, scale];
    const est: Vec3 = [raw[0] * m[0], raw[1] * m[1], raw[2] * m[2]];
    if (tracked) {
      const k = Math.min(1, dt * 2); // ~0.5 s time constant
      for (let i = 0; i < 3; i++) this.off[i] += (head[i] - est[i] - this.off[i]) * k;
      this.learned = Math.min(1, this.learned + dt);
      this.hiddenFor = 0;
      this.sm = null;
      return null;
    }
    if (this.learned < 0.5) return null; // never saw the face yet — no reliable offset
    this.hiddenFor += dt;
    const target: Vec3 = [est[0] + this.off[0], est[1] + this.off[1], est[2] + this.off[2]];
    // keypoints are noisier than the face mesh: extra smoothing; start from the last tracked pose
    const k = 1 - Math.exp(-8 * dt);
    this.sm ??= [...head] as Vec3;
    for (let i = 0; i < 3; i++) this.sm[i] += (target[i] - this.sm[i]) * k;
    return [Math.max(-1.3, Math.min(1.3, this.sm[0])), Math.max(-1, Math.min(1, this.sm[1])), Math.max(-0.9, Math.min(0.9, this.sm[2]))];
  }
}

/** Head [yaw, pitch, roll] in face-solver convention (radians, before mirroring) from a pose result. */
export function headFromPose(pose: PoseLandmarkerResult | null, aspect: number): Vec3 | null {
  const lm = pose?.landmarks?.[0];
  if (!lm || lm.length < 9) return null;
  // BlazePose: 0 nose, 2 left eye, 5 right eye, 7 left ear, 8 right ear (performer's left/right)
  const vis = (i: number) => (lm[i].visibility ?? 1) > 0.5;
  if (![0, 2, 5, 7, 8].every(vis)) return null;
  const raw = headFromKeypoints({ nose: lm[0], eyeL: lm[2], eyeR: lm[5], earL: lm[7], earR: lm[8] }, aspect, null);
  if (!raw) return null;
  const F = POSE_HEAD_FIT;
  return [raw[0] * F.yaw.a + F.yaw.b, raw[1] * F.pitch.a + F.pitch.b, raw[2] * F.roll.a + F.roll.b];
}
