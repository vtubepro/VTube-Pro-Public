// A skinned mesh's first draw: three.js sorts by the object's bounding sphere and computes it once by skinning every
// vertex on the CPU (SkinnedMesh.computeBoundingSphere) — 60-80 ms in the frame a detailed avatar first appears
// (measured: tools/perf_show.mjs --loads, a costume change / guest joining). When its skinned bounding BOX is already
// known (the avatar loader measures every model with Box3.setFromObject, which computes it, in the same rest pose), the
// sphere around that box is used instead: it holds every vertex the per-vertex sphere held (a little larger), and like
// three.js's own it is a one-time snapshot. Meshes without a box keep three.js's computation.
import * as THREE from 'three';

let installed = false;
export function installSkinBounds() {
  if (installed) return;
  installed = true;
  const P = THREE.SkinnedMesh.prototype;
  const own = P.computeBoundingSphere;
  P.computeBoundingSphere = function (this: THREE.SkinnedMesh) {
    const b = this.boundingBox;
    if (b && !b.isEmpty()) {
      (this.boundingSphere ??= new THREE.Sphere());
      b.getBoundingSphere(this.boundingSphere);
      return;
    }
    own.call(this);
  };
}
