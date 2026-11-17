// Avatar detail: the FULL triangle list of a geometry, whatever level is drawn right now. Code that reads an avatar's
// triangles later on (seat drape, food mess, rest raycasts, surface patches) must use this, never geometry.index: a
// lighter level may be swapped in (src/avatar/lod/AvatarDetail.ts keeps the original on userData.vtpLodFull).
//
// holdFull(): an overlay drawn ON an avatar surface at runtime (the food-mess patches, src/avatar/foodMess.ts) sits only
// a fraction of a millimetre above the skin. A lighter level of the surface under it can bulge out by more than that
// (0.5 / 1.5 / 4 mm body error) and hide parts of the overlay: a depth-test occlusion that the pixel-error rule does
// not bound. So while such an overlay is shown, its host geometry (and the twins that switch with it) is drawn at its
// full triangle list: under the overlay the surface is exactly Full's. Other geometries keep their level (their borders
// are locked, so mixing levels between geometries leaves no cracks), and a different surface in front of the overlay
// only moves by the usual <= T px.
import type * as THREE from 'three';

export function fullIndex(g: THREE.BufferGeometry): THREE.BufferAttribute | null {
  return (g.userData?.vtpLodFull as THREE.BufferAttribute | undefined) ?? g.index;
}

const holds = new WeakMap<THREE.BufferGeometry, number>();
const watchers = new WeakMap<THREE.BufferGeometry, () => void>();

/** Draw `g` at its full triangle list until the returned release function is called (counted: several overlays may
 *  hold one geometry). Takes effect at once when Avatar detail has levels for it; before that, when they arrive. */
export function holdFull(g: THREE.BufferGeometry): () => void {
  holds.set(g, (holds.get(g) ?? 0) + 1);
  watchers.get(g)?.();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (holds.get(g) ?? 1) - 1;
    if (n > 0) holds.set(g, n); else holds.delete(g);
    watchers.get(g)?.();
  };
}

/** Is `g` held at its full triangle list right now? */
export const heldFull = (g: THREE.BufferGeometry): boolean => (holds.get(g) ?? 0) > 0;

/** Avatar detail: be told when a hold on `g` starts or ends (null = stop). One watcher per geometry. */
export function watchHold(g: THREE.BufferGeometry, fn: (() => void) | null) {
  if (fn) watchers.set(g, fn); else watchers.delete(g);
}
