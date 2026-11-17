// Ship crew: the room-geometry probe the deck fit (crewDeck.ts snapDeck) runs against: BVH rays (three-mesh-bvh,
// sharing geometry.boundsTree with the shot solver / cam_eval) over the room GLB's static meshes, in deck space.
// Rigidly skinned parts (the walker's legs and turrets, SPEC D19) count at their bind pose (= rest). Skipped: _LOD1+
// twins (every page fits against the same LOD0 surfaces whatever its quality preset or camera), LEG_* part meshes (they
// move), data meshes the room never draws (colliders, env volumes, skin templates) except FLOOR_* walk floors, and
// anything the crew / voyage add at run time (only the GLB model is walked).
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { isWalkFloor } from '../contract.ts';
import type { DeckProbe } from './crewDeck.ts';

interface Item { bvh: MeshBVH; toLocal: THREE.Matrix4; toDeck: THREE.Matrix4; nrm: THREE.Matrix3; box: THREE.Box3 }

const SKIP = /^(vtp:|ENV_|CAM_|COLLIDE_|LEG_|SCREEN|EMIT_|BG_ZONE_|SMASH_)/;

/** Static room meshes worth fitting the crew against. Chosen by NAME and data flags only, never by `visible`: the LOD
 *  system hides _LOD0 levels when the camera is far (gfx/lod.ts), and the fit must come out the same on every page
 *  whatever its camera or quality preset (the plans, and so the sync hash, are built on it). Data meshes the room never
 *  draws are left out (colliders, *_SKIN templates, smash pieces, scene.json hideNodes); FLOOR_* walk floors are in. */
export function probeMeshes(model: THREE.Object3D, hideNodes: Iterable<string> = []): THREE.Mesh[] {
  const hide = new Set(hideNodes);
  const out: THREE.Mesh[] = [];
  model.updateMatrixWorld(true);
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    // (a rigidly skinned part - the walker's legs and turrets, SPEC D19 - is taken at its bind pose: at rest that is
    // where it is drawn)
    if (!m.isMesh || !m.geometry?.attributes?.position) return;
    for (let p: THREE.Object3D | null = o; p && p !== model.parent; p = p.parent) {
      if (/_LOD[1-9]$/.test(p.name) || SKIP.test(p.name) || /_SKIN$/.test(p.name) || hide.has(p.name)) return;
      if ((p.userData as { hiddenUntilBroken?: unknown }).hiddenUntilBroken === true) return;
      if (isWalkFloor(p)) break;
    }
    out.push(m);
  });
  return out;
}

/** Build the meshes' BVHs one mesh per step (a generator: crewScene slices it between frames; RoomDeckProbe then
 *  reuses them). A mesh that fails is skipped by the probe. */
export function* bvhSteps(meshes: THREE.Mesh[]): Generator<void, void> {
  for (const m of meshes) {
    const g = m.geometry as THREE.BufferGeometry & { boundsTree?: MeshBVH };
    if (g.boundsTree) continue;
    try { g.boundsTree = new MeshBVH(g); } catch { /* skipped */ }
    yield;
  }
}

export class RoomDeckProbe implements DeckProbe {
  private items: Item[] = [];
  private ray = new THREE.Ray();
  private o = new THREE.Vector3();
  private d = new THREE.Vector3();
  private seg = new THREE.Box3();
  private hitP = new THREE.Vector3();
  private n = new THREE.Vector3();
  /** BVH build time (ms) */
  readonly buildMs: number;
  readonly tris: number;

  constructor(meshes: THREE.Mesh[], space: THREE.Object3D) {
    const t0 = performance.now();
    space.updateMatrixWorld(true);
    const deckInv = new THREE.Matrix4().copy(space.matrixWorld).invert();
    let tris = 0;
    for (const m of meshes) {
      const g = m.geometry as THREE.BufferGeometry & { boundsTree?: MeshBVH };
      if (!g.boundsTree) { try { g.boundsTree = new MeshBVH(g); } catch { continue; } }
      tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
      const toDeck = new THREE.Matrix4().multiplyMatrices(deckInv, m.matrixWorld);
      const toLocal = toDeck.clone().invert();
      if (!g.boundingBox) g.computeBoundingBox();
      const box = g.boundingBox!.clone().applyMatrix4(toDeck);
      this.items.push({ bvh: g.boundsTree, toLocal, toDeck, nrm: new THREE.Matrix3().getNormalMatrix(toDeck), box });
    }
    this.tris = Math.round(tris);
    this.buildMs = performance.now() - t0;
  }
  get size() { return this.items.length; }

  floors(x: number, z: number, yTop: number, yBot: number): number[] {
    const out: number[] = [];
    this.seg.min.set(x - 1e-3, yBot, z - 1e-3); this.seg.max.set(x + 1e-3, yTop, z + 1e-3);
    for (const it of this.items) {
      if (!it.box.intersectsBox(this.seg)) continue;
      this.ray.origin.set(x, yTop, z); this.ray.direction.set(0, -1, 0);
      this.ray.applyMatrix4(it.toLocal);
      const hits = it.bvh.raycast(this.ray, THREE.DoubleSide);
      for (const h of hits) {
        if (!h.face) continue;
        this.hitP.copy(h.point).applyMatrix4(it.toDeck);
        if (this.hitP.y > yTop + 1e-4 || this.hitP.y < yBot - 1e-4) continue;
        this.n.copy(h.face.normal).applyMatrix3(it.nrm).normalize();
        // (up-facing only: the underside of a deck above is a ceiling, not somewhere to stand)
        if (this.n.y < 0.6) continue;
        out.push(this.hitP.y);
      }
    }
    out.sort((a, b) => b - a);
    return out.filter((y, i) => i === 0 || out[i - 1] - y > 0.01);
  }

  free(p: THREE.Vector3, dx: number, dz: number, far: number): number {
    let best = Infinity;
    this.d.set(dx, 0, dz).normalize();
    this.seg.makeEmpty().expandByPoint(p).expandByPoint(this.o.copy(p).addScaledVector(this.d, far));
    for (const it of this.items) {
      if (!it.box.intersectsBox(this.seg)) continue;
      this.ray.origin.copy(p); this.ray.direction.copy(this.d);
      this.ray.applyMatrix4(it.toLocal);
      const h = it.bvh.raycastFirst(this.ray, THREE.DoubleSide);
      if (!h) continue;
      const d = this.hitP.copy(h.point).applyMatrix4(it.toDeck).distanceTo(p);
      if (d <= far && d < best) best = d;
    }
    return best;
  }
}
