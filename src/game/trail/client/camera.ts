// The Trail — cameras. A proper third-person spring arm (shoulder offset, zoom, collision against the real level
// geometry through BVH ray casts, instant pull-in / eased push-out, smoothing that never lags the player), a clean first
// person, and the collision test the spectator director uses so a stream shot never sits inside a wall, the wagon or a
// hill. Allocation-free per frame. Level meshes get a BVH (three-mesh-bvh, already a dependency) in idle time; until a
// mesh has one it is not ray-cast (no brute-force casts against 40k-triangle meshes on the frame).
import * as THREE from 'three';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';

// (this page only: trail.html is its own document)
(THREE.BufferGeometry.prototype as unknown as { computeBoundsTree: typeof computeBoundsTree }).computeBoundsTree = computeBoundsTree;
(THREE.BufferGeometry.prototype as unknown as { disposeBoundsTree: typeof disposeBoundsTree }).disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const ray = new THREE.Raycaster();
(ray as unknown as { firstHitOnly: boolean }).firstHitOnly = true;
const hits: THREE.Intersection[] = [];
const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3(), v4 = new THREE.Vector3(), v5 = new THREE.Vector3(), sph = new THREE.Sphere();

/** Everything a camera must not pass through. */
export interface CamBlockers {
  /** Level meshes that already have a BVH + the grey-box collider boxes. */
  meshes: THREE.Object3D[];
  /** Extra objects this frame (the wagon's visible meshes, when not riding it). */
  extra: THREE.Object3D[];
  /** Big animated bodies as spheres (never ray-cast skinned meshes). */
  spheres: { c: THREE.Vector3; r: number }[];
  /** v2 journey: terrain height under a point (hills block the camera; it never goes underground). */
  ground?: ((x: number, z: number) => number) | null;
}

/** Distance from `from` towards `to` that is clear (≤ |to − from|). */
export function clearDistance(from: THREE.Vector3, to: THREE.Vector3, b: CamBlockers): number {
  const dir = v1.subVectors(to, from);
  const len = dir.length();
  if (len < 1e-4) return 0;
  dir.divideScalar(len);
  ray.set(from, dir);
  ray.far = len;
  let best = len;
  hits.length = 0;
  if (b.meshes.length) { ray.intersectObjects(b.meshes, false, hits); for (const h of hits) if (h.distance < best) best = h.distance; }
  hits.length = 0;
  if (b.extra.length) { ray.intersectObjects(b.extra, true, hits); for (const h of hits) if (h.distance < best && h.object.visible && !(h.object.userData as { isOutline?: boolean }).isOutline) best = h.distance; }
  for (const s of b.spheres) {
    sph.center.copy(s.c); sph.radius = s.r;
    if (sph.containsPoint(from)) continue;
    if (ray.ray.intersectSphere(sph, v2)) { const d = v2.distanceTo(from); if (d < best) best = d; }
  }
  // terrain: march the ray (≤ 16 samples) — the first sample under the ground ends it
  if (b.ground) {
    const steps = Math.min(16, Math.ceil(best / 0.8));
    for (let i = 1; i <= steps; i++) {
      const d = best * i / steps;
      const x = from.x + dir.x * d, y = from.y + dir.y * d, z = from.z + dir.z * d;
      if (y < b.ground(x, z) + 0.25) { best = Math.max(0, d - best / steps); break; }
    }
  }
  return best;
}

export interface ThirdPersonIn {
  /** Point to orbit (chest height of the player). */
  target: THREE.Vector3;
  yaw: number; pitch: number;
  /** Player height (m): distances scale with it. */
  h: number;
  /** Riding / driving: further out, higher, eased toward the travel direction. */
  riding: boolean;
  /** Heading of the thing being ridden (rad), for the auto-follow. */
  rideYaw?: number;
  dt: number;
}

export class CameraRig {
  /** Mouse-wheel zoom (1 = default). */
  zoom = 1;
  private pivot = new THREE.Vector3();
  private have = false;
  private dist = 3;
  private rideYawOff = 0;
  readonly pos = new THREE.Vector3();
  readonly look = new THREE.Vector3();

  constructor(private camera: THREE.PerspectiveCamera) {}
  reset() { this.have = false; }
  /** A big jump of the world (the road's floating origin): keep the smoothing continuous. */
  shift(dz: number, dx = 0) { this.pivot.z += dz; this.pos.z += dz; this.look.z += dz; this.pivot.x += dx; this.pos.x += dx; this.look.x += dx; this.chaseP.x += dx; this.chaseP.z += dz; this.chaseL.x += dx; this.chaseL.z += dz; }

  third(i: ThirdPersonIn, b: CamBlockers) {
    const cam = this.camera;
    // pivot: follows the player tightly sideways (no lag = no swimmy aim), a little softer vertically (steps, bobs)
    if (!this.have || this.pivot.distanceToSquared(i.target) > 25) { this.pivot.copy(i.target); this.have = true; this.dist = 0.6; }
    const kx = 1 - Math.exp(-i.dt * 30), ky = 1 - Math.exp(-i.dt * 12);
    this.pivot.x += (i.target.x - this.pivot.x) * kx;
    this.pivot.z += (i.target.z - this.pivot.z) * kx;
    this.pivot.y += (i.target.y - this.pivot.y) * ky;
    const h = Math.max(0.3, i.h);
    let want = Math.max(2.2, h * 2.1) * this.zoom;
    let yaw = i.yaw, pitch = i.pitch;
    if (i.riding) { want = Math.max(5.5, h * 2.8) * this.zoom; pitch = Math.min(pitch, 0.05) - 0.22; }
    const cp = Math.cos(pitch);
    const fwd = v1.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
    const right = v2.set(Math.cos(yaw), 0, -Math.sin(yaw));
    const shoulder = i.riding ? 0 : Math.min(0.75, h * 0.32);
    // the arm end (before collision)
    const end = v3.copy(this.pivot).addScaledVector(fwd, -want).addScaledVector(right, shoulder);
    end.y += i.riding ? 1.2 : Math.min(0.35, h * 0.15);
    const armDir = v4.copy(end).sub(this.pivot);
    const armLen = armDir.length();
    armDir.divideScalar(Math.max(1e-4, armLen));
    const endPt = v5.copy(end);
    const free = clearDistance(this.pivot, endPt, b);
    const allowed = Math.max(0.35, Math.min(armLen, free - 0.25));
    // pull in at once (never see through a wall), ease back out
    if (allowed < this.dist) this.dist = allowed; else this.dist += (allowed - this.dist) * (1 - Math.exp(-i.dt * 4));
    this.pos.copy(this.pivot).addScaledVector(armDir, this.dist);
    const lookFwd = v1.set(-Math.sin(yaw) * Math.cos(i.pitch), Math.sin(i.pitch), -Math.cos(yaw) * Math.cos(i.pitch));
    this.look.copy(this.pivot).addScaledVector(lookFwd, 6);
    if (b.ground) { const g = b.ground(this.pos.x, this.pos.z) + 0.35; if (this.pos.y < g) this.pos.y = g; }
    cam.position.copy(this.pos);
    cam.lookAt(this.look);
    cam.fov = i.riding ? 62 : 68;
    void this.rideYawOff;
  }

  /** Driving: a chase camera behind the wagon that looks ahead into turns, leans with the steering, pulls back with
   *  speed, kicks the FOV on the whip. `look` (mouse) swings it around for a moment; it drifts back behind. */
  private chaseP = new THREE.Vector3(); private chaseL = new THREE.Vector3(); private haveChase = false; private chaseYaw = 0;
  chase(i: { at: THREE.Vector3; heading: number; speed: number; steer: number; whip: boolean; lookOff: number; dt: number }, b: CamBlockers) {
    const cam = this.camera;
    const fx = Math.sin(i.heading), fz = Math.cos(i.heading);
    const back = (8.5 + Math.min(6, Math.abs(i.speed) * 0.45)) * this.zoom;
    this.chaseYaw += (i.lookOff - this.chaseYaw) * (1 - Math.exp(-i.dt * 3));
    const yaw = i.heading + Math.PI + this.chaseYaw - i.steer * 0.35;
    const want = v3.set(i.at.x + Math.sin(yaw) * back, i.at.y + 3.4 + Math.abs(i.speed) * 0.08, i.at.z + Math.cos(yaw) * back);
    const look = v4.set(i.at.x + fx * (6 + Math.abs(i.speed) * 1.2) - Math.cos(i.heading) * i.steer * 5, i.at.y + 1.6, i.at.z + fz * (6 + Math.abs(i.speed) * 1.2) + Math.sin(i.heading) * i.steer * 5);
    if (!this.haveChase || this.chaseP.distanceToSquared(want) > 900) { this.chaseP.copy(want); this.chaseL.copy(look); this.haveChase = true; }
    const k = 1 - Math.exp(-i.dt * 5), kl = 1 - Math.exp(-i.dt * 7);
    this.chaseP.lerp(want, k); this.chaseL.lerp(look, kl);
    const piv = v5.set(i.at.x, i.at.y + 2.2, i.at.z);
    const free = clearDistance(piv, this.chaseP, b);
    const len = piv.distanceTo(this.chaseP);
    this.pos.copy(this.chaseP);
    if (free < len - 0.05) this.pos.sub(piv).multiplyScalar(Math.max(0.5, free - 0.3) / len).add(piv);
    if (b.ground) { const g = b.ground(this.pos.x, this.pos.z) + 0.6; if (this.pos.y < g) this.pos.y = g; }
    cam.position.copy(this.pos);
    cam.lookAt(this.chaseL);
    const fov = 64 + Math.min(8, Math.abs(i.speed) * 0.6) + (i.whip ? 6 : 0);
    cam.fov += (fov - cam.fov) * Math.min(1, i.dt * 4);
    this.have = false;
  }
  resetChase() { this.haveChase = false; }

  first(eye: THREE.Vector3, yaw: number, pitch: number) {
    const cam = this.camera;
    cam.position.copy(eye);
    this.look.set(eye.x - Math.sin(yaw) * Math.cos(pitch), eye.y + Math.sin(pitch), eye.z - Math.cos(yaw) * Math.cos(pitch));
    cam.lookAt(this.look);
    cam.fov = 78;
    this.have = false;
  }

  /** Spectator: move a wanted shot out of any geometry between it and what it looks at. */
  unblock(pos: THREE.Vector3, look: THREE.Vector3, b: CamBlockers) {
    const d = pos.distanceTo(look);
    const free = clearDistance(look, pos, b);
    if (free < d - 0.05) pos.sub(look).multiplyScalar(Math.max(0.4, free - 0.3) / d).add(look);
  }
}
