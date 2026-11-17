// Ship crew: the face guard's geometry (pure; crewScene runs it every frame).
import * as THREE from 'three';

export type Rect = { x0: number; y0: number; x1: number; y1: number };
/** Screen rect (0..1, y down) of a crew member's whole body - feet, the head joint and the TOP of the puppet head + hat
 *  (the puppet unit's Head joint sits at the base of a 0.62 m head: the old head-joint test missed the top half), widened by
 *  the body's half width - and its distance from the camera. null = behind the camera. */
export function crewScreenRect(cam: THREE.Camera, feet: THREE.Vector3, head: THREE.Vector3, top: THREE.Vector3, halfW: number): (Rect & { depth: number }) | null {
  const side = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion())).multiplyScalar(halfW);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const q = new THREE.Vector3();
  for (const p of [feet, head, top]) for (const k of [-1, 0, 1]) {
    q.copy(p).addScaledVector(side, k).project(cam);
    if (q.z > 1 || q.z < -1) continue;
    const x = (q.x + 1) / 2, y = (1 - q.y) / 2;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  if (x0 === Infinity) return null;
  return { x0, y0, x1, y1, depth: cam.getWorldPosition(q).distanceTo(head) };
}
/** Face guard verdict for one crew rect against the face rects (with their depths): 'hide' = between the lens and a face
 *  (gone at once), 'fade' = overlapping a face further back (fades out), 'ok'. */
export function guardVerdict(r: (Rect & { depth: number }) | null, faces: (Rect & { depth?: number })[]): 'ok' | 'fade' | 'hide' {
  if (!r) return 'ok';
  let v: 'ok' | 'fade' | 'hide' = 'ok';
  for (const f of faces) {
    if (r.x1 < f.x0 || r.x0 > f.x1 || r.y1 < f.y0 || r.y0 > f.y1) continue;
    if (f.depth !== undefined && r.depth < f.depth) return 'hide';
    v = 'fade';
  }
  return v;
}
