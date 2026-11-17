// Smooth camera moves between scene camera poses (presets, auto talk framing, react).
import * as THREE from 'three';

export interface CamPose { position: THREE.Vector3; quaternion: THREE.Quaternion; fov: number }

export const clonePose = (p: CamPose): CamPose => ({ position: p.position.clone(), quaternion: p.quaternion.clone(), fov: p.fov });
export const copyPose = (to: CamPose, p: CamPose): CamPose => { to.position.copy(p.position); to.quaternion.copy(p.quaternion); to.fov = p.fov; return to; };

export function lookPose(position: THREE.Vector3, target: THREE.Vector3, fov: number): CamPose {
  const m = new THREE.Matrix4().lookAt(position, target, new THREE.Vector3(0, 1, 0));
  return { position: position.clone(), quaternion: new THREE.Quaternion().setFromRotationMatrix(m), fov };
}

function samePose(a: CamPose, b: CamPose) {
  return a.position.distanceToSquared(b.position) < 1e-6 && Math.abs(a.quaternion.dot(b.quaternion)) > 0.999999 && Math.abs(a.fov - b.fov) < 1e-3;
}

export class CameraRig {
  current: CamPose | null = null;
  private from: CamPose | null = null;
  target: CamPose | null = null;
  private t = 1;
  private dur = 1.2;
  /** Optional sideways/up bulge of the path (m) at mid-move — a parallax arc instead of a straight dolly. */
  private arc: THREE.Vector3 | null = null;
  /** Seconds since the last move finished (0 while moving). */
  settledFor = 0;

  /** Aim at a new pose; `seconds` 0 = cut. Re-aiming at the same pose is a no-op - unless the caller names a start pose: `from` = start
   *  the move from this pose (a crane's high start, the single a push-in grows out of) instead of wherever the camera is, and a move
   *  that starts elsewhere is not "the same pose" even when it ends on the one on air (Show open while the host's single is up). `t0` =
   *  start that far into it (0…1: a page that joined a timed move late shows the pose a page that saw the cut shows at the same
   *  moment). Only a shot-key change calls this with a `from`, never a frame loop. */
  go(p: CamPose, seconds: number, arc: THREE.Vector3 | null = null, from?: CamPose, t0 = 0) {
    if (this.target && !from && samePose(this.target, p)) return;
    this.target = clonePose(p);
    this.arc = arc;
    if (seconds <= 0 || (!this.current && !from)) { this.current = clonePose(p); this.t = 1; return; }
    this.from = clonePose(from ?? this.current!);
    this.dur = seconds;
    this.t = Math.min(0.999, Math.max(0, t0));
    this.settledFor = 0;
    if (!this.current || from) this.current = clonePose(this.from);
  }

  /** Seconds left in the current move (0 = settled). */
  get remaining() { return (1 - this.t) * this.dur; }

  /** Target moved a little (e.g. an avatar's spot shifted mid-move): follow without restarting the move. */
  nudge(p: CamPose) {
    if (!this.target) return this.go(p, 0);
    // (copied into the rig's own poses, not cloned: a director's moving shot nudges every frame)
    copyPose(this.target, p);
    if (this.t >= 1 && this.current) copyPose(this.current, p);
  }

  get moving() { return this.t < 1; }

  update(dt: number, cam: THREE.PerspectiveCamera) {
    if (!this.current || !this.target) return;
    if (this.t < 1 && this.from) {
      this.t = Math.min(1, this.t + dt / this.dur);
      const t = this.t;
      const k = t * t * t * (t * (t * 6 - 15) + 10);                // smootherstep in/out
      this.current.position.lerpVectors(this.from.position, this.target.position, k);
      // lift the path a touch mid-move so long dolly moves don't clip furniture (+ the optional parallax arc)
      const bulge = Math.sin(Math.PI * k);
      const lift = bulge * Math.min(0.35, this.from.position.distanceTo(this.target.position) * 0.08);
      this.current.position.y += lift;
      if (this.arc) this.current.position.addScaledVector(this.arc, bulge);
      this.current.quaternion.slerpQuaternions(this.from.quaternion, this.target.quaternion, k);
      this.current.fov = THREE.MathUtils.lerp(this.from.fov, this.target.fov, k);
    } else {
      this.current = clonePose(this.target);
      this.settledFor += dt;
    }
    cam.position.copy(this.current.position);
    cam.quaternion.copy(this.current.quaternion);
    if (cam.fov !== this.current.fov || cam.zoom !== 1) { cam.fov = this.current.fov; cam.zoom = 1; cam.updateProjectionMatrix(); }
  }
}
