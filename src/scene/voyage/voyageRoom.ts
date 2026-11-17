// Voyage room: what the engine reads from the room (scene.json `voyage` + GLB anchors), in the SHIP frame (= the room
// root's glTF frame: origin = show deck floor centre, +Y up, bow -Z unless VOYAGE_BOW says otherwise).
//   spots      every SPOT_xx (keep-outs: no effect within 12 m at full size; cameras never cut inside them)
//   dry        ENV_DRY_* boxes + environment.dry (no sand streaks under the awning / below decks)
//   below      BELOW__* nodes present (the TTRPG cabin area) - lanterns swing there
// Plus demoConfig(): a `voyage` config for ANY room (test pages, &voyageCfg=demo): the room's floor becomes the show deck
// of the procedural placeholder ship.
import * as THREE from 'three';
import type { SceneRuntime } from '../SceneRuntime.ts';
import type { RoomVoyageConfig } from '../../../shared/voyage.ts';

export interface VoyageRoom {
  ship: THREE.Object3D;
  spots: THREE.Vector3[];
  dry: THREE.Box3[];
  below: boolean;
  /** the room's own walker parts (LEG_* nodes) */ hasLegs: boolean;
  /** room bounds in the ship frame (cameras / effects keep out) */ bounds: THREE.Box3;
}

export function voyageRoomOf(rt: SceneRuntime, cfg: RoomVoyageConfig): VoyageRoom {
  const ship = rt.room.root;
  ship.updateWorldMatrix(true, true);
  const toShip = (p: THREE.Vector3) => ship.worldToLocal(p.clone());
  const spots = rt.room.spots.filter((s): s is NonNullable<typeof s> => !!s).map((s) => toShip(s.position));
  const dry: THREE.Box3[] = [];
  let hasLegs = false, below = false;
  ship.traverse((o) => {
    if (/^ENV_DRY/.test(o.name)) {
      const b = new THREE.Box3().setFromObject(o);
      if (!b.isEmpty()) dry.push(new THREE.Box3(toShip(b.min), toShip(b.max)));
    }
    if (/^LEG_[A-Z]{1,2}\d?_(HIP|COXA)$/.test(o.name)) hasLegs = true;
    if (/^BELOW__/.test(o.name)) below = true;
  });
  const env = (rt.info as unknown as { environment?: { dry?: number[][] } }).environment;
  for (const d of env?.dry ?? []) if (Array.isArray(d) && d.length === 6 && d.every((x) => typeof x === 'number')) dry.push(new THREE.Box3(new THREE.Vector3(d[0], d[1], d[2]), new THREE.Vector3(d[3], d[4], d[5])));
  // with no authored dry box: the show deck under an awning-height roof stays dry
  if (!dry.length && spots.length) {
    const b = new THREE.Box3().setFromPoints(spots);
    dry.push(new THREE.Box3(b.min.clone().add(new THREE.Vector3(-1.6, -0.5, -1.6)), b.max.clone().add(new THREE.Vector3(1.6, 3.3, 1.6))));
  }
  const bounds = rt.room.bounds.isEmpty() ? new THREE.Box3(new THREE.Vector3(-5, -1, -5), new THREE.Vector3(5, 4, 5)) : new THREE.Box3(toShip(rt.room.bounds.min), toShip(rt.room.bounds.max));
  void cfg;
  return { ship, spots, dry, below, hasLegs, bounds };
}

/** A demo `voyage` config for any room: the procedural ship under the room's floor (test pages only). */
export function demoConfig(rt: SceneRuntime): RoomVoyageConfig {
  void rt;
  return { ship: 'procedural', pacing: 'normal', groundY: -12.844, dangerSide: 'aft-port' };
}
