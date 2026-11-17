// The Interview call-in screen's housing (SPEC 6.1 C7): the room node the guest picture sits ON, when it sits on one.
//   - scene.json `interview.monitor.node` names it (a picture rect authored on the room's own TV glass: the late-night
//     room's TALK_MONITOR_SKIN on its CRT): the picture is placed on that node (its world centre, facing its +Z) unless
//     `position` / `yaw` pin it, and rides it;
//   - else a `skin` monitor rides its own skin template (the room node its housing is cloned from).
// The picture then follows the node's whole world move since the set was built (shared/forms.ts callInOffset): when the
// room's forms move that node (a pylon stage) the picture goes with it, and when nothing moves it the picture stays on
// the glass. It never takes the self-lift (fit.monY over the floor probed from the glass - inside a TV that probe meets
// the TV's own cabinet: the late-night room lifted the guest 0.965 m into the CRT's frame).
// Three.js only, no DOM: src/scene/talkshow/engine.ts uses it; Node test tools/callin_lift_unit.ts.
import * as THREE from 'three';

export interface CallInHousing {
  node: THREE.Object3D;
  /** The node's world position when the set was built. */
  p0: THREE.Vector3;
  /** 'node' = scene.json interview.monitor.node; 'skin' = the skin monitor's own template. */
  from: 'node' | 'skin';
}

/** The room node a call-in picture sits on: `name` (interview.monitor.node) when the room has it, else a skin monitor's
 *  template; null = a screen the set brought (it may self-lift). */
export function findCallInHousing(o: { root: THREE.Object3D; name?: string | null; style: string; skinTemplate?: THREE.Object3D | null }): CallInHousing | null {
  const named = typeof o.name === 'string' && o.name ? o.root.getObjectByName(o.name) ?? null : null;
  const node = named ?? (o.style === 'skin' ? o.skinTemplate ?? null : null);
  if (!node) return null;
  node.updateWorldMatrix(true, false);
  return { node, p0: node.getWorldPosition(new THREE.Vector3()), from: named ? 'node' : 'skin' };
}

/** The picture's place ON its housing node: the node's world centre, facing the node's world +Z (yaw about +Y). */
export function housingPlace(h: CallInHousing, width: number): { center: THREE.Vector3; yaw: number; width: number } {
  h.node.updateWorldMatrix(true, false);
  const z = new THREE.Vector3(0, 0, 1).transformDirection(h.node.matrixWorld);
  return { center: h.node.getWorldPosition(new THREE.Vector3()), yaw: Math.atan2(z.x, z.z), width };
}

/** The housing's world move since the set was built, into `out` as [x, y, z] (no allocation; `tmp` is scratch). */
export function housingDelta(h: CallInHousing, out: [number, number, number], tmp: THREE.Vector3): [number, number, number] {
  h.node.updateWorldMatrix(true, false);
  h.node.getWorldPosition(tmp).sub(h.p0);
  out[0] = tmp.x; out[1] = tmp.y; out[2] = tmp.z;
  return out;
}
