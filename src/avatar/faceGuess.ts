// First-guess eye + mouth markers for models that arrive with no face rig (uploads / AI generations),
// so they animate right away; the Face tab is only for fine-tuning.
//
// The head is the region above the humanoid head bone (or the top 28% of the model); eyes sit at ~55%
// of its height, ±19% of its width apart, the mouth at ~28%. Each is ray-cast onto the FRONT surface.
import * as THREE from 'three';
import type { SurfaceMarker } from '../../shared/types.ts';

export interface FaceGuess {
  eyes: { left: SurfaceMarker; right: SurfaceMarker; size: number } | null;
  mouth: { center: SurfaceMarker; width: number; openHeight: number; influence: number } | null;
  /** Big head relative to the body (mascots / critters): bulb eyes read better than inset ones. */
  mascot: boolean;
}

export function guessFaceMarkers(model: THREE.Object3D, meshes: THREE.Mesh[], headBone: THREE.Object3D | null, yawDeg = 0): FaceGuess | null {
  model.updateWorldMatrix(true, true);
  const inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
  // all vertices in MODEL space (skinned: bind pose)
  const pts: THREE.Vector3[] = [];
  const v = new THREE.Vector3();
  for (const m of meshes) {
    const pos = m.geometry.attributes.position as THREE.BufferAttribute;
    const stride = Math.max(1, Math.floor(pos.count / 30000));
    for (let i = 0; i < pos.count; i += stride) {
      v.fromBufferAttribute(pos, i);
      if ((m as THREE.SkinnedMesh).isSkinnedMesh) (m as THREE.SkinnedMesh).applyBoneTransform(i, v);
      pts.push(v.clone().applyMatrix4(m.matrixWorld).applyMatrix4(inv));
    }
  }
  if (pts.length < 50) return null;
  const all = new THREE.Box3().setFromPoints(pts);
  const H = all.max.y - all.min.y;
  const headY = headBone ? headBone.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv).y : all.max.y - 0.28 * H;
  const head = pts.filter((p) => p.y >= headY);
  if (head.length < 20) return null;
  const hb = new THREE.Box3().setFromPoints(head);
  const hw = hb.max.x - hb.min.x, hh = hb.max.y - hb.min.y, cx = (hb.max.x + hb.min.x) / 2;
  // forward in model space (+Z, unless the profile turns the model around)
  const yaw = THREE.MathUtils.degToRad(yawDeg);
  const fwd = new THREE.Vector3(Math.sin(-yaw), 0, Math.cos(-yaw));
  const ray = new THREE.Raycaster();
  const nm = new THREE.Matrix3();
  const hit = (x: number, y: number): SurfaceMarker | null => {
    const from = new THREE.Vector3(x, y, 0).addScaledVector(fwd, 10).applyMatrix4(model.matrixWorld);
    const dir = fwd.clone().negate().transformDirection(model.matrixWorld);
    ray.set(from, dir);
    const h = ray.intersectObjects(meshes, false)[0];
    if (!h?.face) return null;
    const p = h.point.clone().applyMatrix4(inv);
    nm.getNormalMatrix(h.object.matrixWorld);
    const n = h.face.normal.clone().applyMatrix3(nm).normalize().transformDirection(inv);
    if (n.dot(fwd) < 0.2) n.lerp(fwd, 0.6).normalize();
    const r = (a: THREE.Vector3) => [+a.x.toFixed(4), +a.y.toFixed(4), +a.z.toFixed(4)] as [number, number, number];
    return { position: r(p), normal: r(n) };
  };
  const eyeY = hb.min.y + 0.55 * hh, mouthY = hb.min.y + 0.28 * hh;
  const L = hit(cx + 0.19 * hw, eyeY), R = hit(cx - 0.19 * hw, eyeY), M = hit(cx, mouthY);
  return {
    eyes: L && R ? { left: L, right: R, size: +(0.09 * hw).toFixed(4) } : null,
    mouth: M ? { center: M, width: +(0.18 * hw).toFixed(4), openHeight: +(0.12 * hw).toFixed(4), influence: +(0.3 * hw).toFixed(4) } : null,
    mascot: hh > 0.3 * H,
  };
}
