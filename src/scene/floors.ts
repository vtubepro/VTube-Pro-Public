// Walkable heights (multi-level rooms): stages, stairs, balconies. docs/SCENES.md "Floors".
//
// The walk planner (navigation.ts) is 2-D (x, z). A room with levels adds hidden meshes named FLOOR_* (a stage top, a
// stair ramp, a balcony slab — any shape; contract.ts hides them) and walkers then stand on the HIGHEST FLOOR_*
// surface under them (a downward ray), i.e. they climb the stairs as a smooth ramp instead of gliding along y = 0
// and popping up at an elevated spot. Rooms without FLOOR_* nodes: floorAt() returns 0 (the old behaviour).
// Cheap: FLOOR_* meshes are a handful of triangles; one ray per walker per frame.
import * as THREE from 'three';
import { isWalkFloor, type RoomInfo } from './contract.ts';
import { underHiddenToggle } from './roomToggles.ts';

export class RoomFloors {
  readonly meshes: THREE.Mesh[] = [];
  private ray = new THREE.Raycaster();
  private hits: THREE.Intersection[] = [];
  private top = 50;
  private minY = 0;
  private down = new THREE.Vector3(0, -1, 0);
  private o = new THREE.Vector3();

  constructor(room: RoomInfo) {
    room.root.updateMatrixWorld(true);
    room.root.traverse((n) => {
      if (!isWalkFloor(n)) return;
      n.traverse((c) => { if ((c as THREE.Mesh).isMesh) this.meshes.push(c as THREE.Mesh); });
    });
    const bb = new THREE.Box3();
    for (const m of this.meshes) bb.expandByObject(m);
    if (!bb.isEmpty()) { this.top = bb.max.y + 1; this.minY = bb.min.y; }
  }
  get any() { return this.meshes.length > 0; }

  /** Height of the walkable surface at (x, z) world (0 when no FLOOR_* is under it). */
  at(x: number, z: number, fallback = 0): number {
    if (!this.meshes.length) return fallback;
    this.o.set(x, this.top, z);
    // reach the lowest walk floor (a ship's cabin can sit far below 0, e.g. a walking ship's below-decks at y -7.1)
    this.ray.set(this.o, this.down); this.ray.far = this.top - Math.min(0, this.minY) + 5;
    this.hits.length = 0;
    // (hidden meshes still ray-test: Raycaster ignores .visible)
    this.ray.intersectObjects(this.meshes, false, this.hits);
    // (walk floors inside a room prop toggle that is switched off don't count: src/scene/roomToggles.ts)
    const hit = this.hits.find((h) => !underHiddenToggle(h.object));
    return hit ? hit.point.y : fallback;
  }
}

const cache = new WeakMap<RoomInfo, RoomFloors>();
export function floorsOf(room: RoomInfo): RoomFloors {
  let f = cache.get(room);
  if (!f) { f = new RoomFloors(room); cache.set(room, f); }
  return f;
}
