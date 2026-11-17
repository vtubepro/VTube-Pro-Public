// Hidden NPCs cost no world-matrix work (docs/PERFORMANCE.md "Hidden NPCs").
//
// three.js updates every node's world matrix on every frame, drawn or not. A crowd engine hides the NPCs the camera
// can't see (town crowd: ~800 of ~1000 skeleton nodes in Kingsmarch's talk shot) but their bones were still recomposed
// and multiplied every frame: ~0.8 ms of the page's main thread per frame (measured), for nothing. A unit root wrapped
// here skips its whole subtree while `visible` is false; the frame it shows again it is fully updated (it stays flagged
// while hidden), before it is drawn. Code that needs a hidden unit's world position uses getWorldPosition /
// updateWorldMatrix (another path, untouched); the impostor renderer (src/stage/gfx/npcDetail.ts) shows the root
// before it renders it. Kill switch: ?hiddenSkip=0 on the page URL, or localStorage vtp.hiddenSkip = '0'.
import type * as THREE from 'three';

let enabled: boolean | null = null;
function on(): boolean {
  if (enabled !== null) return enabled;
  enabled = true;
  try {
    if (new URLSearchParams(location.search).get('hiddenSkip') === '0' || localStorage.getItem('vtp.hiddenSkip') === '0') enabled = false;
  } catch { /* no storage: on */ }
  return enabled;
}

/** No world-matrix updates under `root` while it is hidden (a unit / NPC root that its engine hides when culled). */
export function skipMatricesWhileHidden<T extends THREE.Object3D>(root: T): T {
  if (!on()) return root;
  const base = Object.getPrototypeOf(root).updateMatrixWorld as (this: THREE.Object3D, force?: boolean) => void;
  root.updateMatrixWorld = function (this: THREE.Object3D, force?: boolean) {
    if (!this.visible) { this.matrixWorldNeedsUpdate = true; return; }   // (recomputed in full the frame it shows)
    base.call(this, force);
  };
  return root;
}
