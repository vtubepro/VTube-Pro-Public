// Keeps the table readable in every room: while the director is on a table shot (the map / CAM_TABLE_TOP, the dice
// tray, the handout), any room mesh between that camera and the surface — a pendant lamp, a hanging banner, a candle,
// a stack of books, the GM's own figure — is hidden for this camera only, and shown again when the shot changes.
// Hidden = moved to an unused render layer (children such as the lamp's light keep working); only this page's view.
// Found by ray-casting from the shot's camera to a grid of points just above the surface; big meshes (floors, walls,
// the table top — anything wider than 2.2 m) and the surfaces themselves are never hidden. Pieces touching a hidden
// mesh go with it when they hang above the table or are tiny (the lamp's cord and bulb with its shade, a candle's
// flame with the candle) — not the props lying on the table next to it. The dice tray's own walls are never hidden.
import * as THREE from 'three';

const HIDE_LAYER = 31;
const MAX_SIZE = 2.2;

export interface ClearTarget {
  key: string;
  points: THREE.Vector3[];
  /** Height of the surface (the table top): only pieces above it are taken along with a hidden mesh. */
  surfaceY: number;
  /** Never hide meshes that reach into these volumes (the dice tray's own walls for the dice shot). */
  protect?: THREE.Box3[];
}

export class ClearShot {
  private hidden = new Map<THREE.Object3D, number>();
  private key = '';
  private ray = new THREE.Raycaster();
  private box = new THREE.Box3();
  private size = new THREE.Vector3();
  /** Debug: names of the meshes hidden for the current shot. */
  names: string[] = [];

  /** @param roots where occluders may be (the room model, the GM's figure)
   *  @param keep  never hidden (the map / tray / handout surfaces and their ancestors) */
  constructor(private roots: () => THREE.Object3D[], private keep: () => THREE.Object3D[]) {}

  /** Call every frame with the shot's final camera position and what it must see (null = no table shot). */
  update(cam: THREE.Vector3 | null, target: ClearTarget | null) {
    if (!cam || !target || !target.points.length) { this.restore(); this.key = ''; return; }
    const k = `${target.key}|${cam.x.toFixed(2)},${cam.y.toFixed(2)},${cam.z.toFixed(2)}`;
    if (k === this.key) return;
    this.key = k;
    this.restore();
    const keep = new Set<THREE.Object3D>();
    for (const o of this.keep()) { let p: THREE.Object3D | null = o; while (p) { keep.add(p); p = p.parent; } o.traverse((c) => keep.add(c)); }
    const cands: THREE.Mesh[] = [], boxes = new Map<THREE.Mesh, THREE.Box3>();
    for (const r of this.roots()) {
      r.updateWorldMatrix(true, true);
      r.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || keep.has(m) || !m.visible || (m as unknown as THREE.SkinnedMesh).isSkinnedMesh) return;
        if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
        const b = m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld);
        b.getSize(this.size);
        if (Math.max(this.size.x, this.size.z) > MAX_SIZE) return;
        if (target.protect?.some((p) => p.intersectsBox(b))) return;
        cands.push(m); boxes.set(m, b);
      });
    }
    if (!cands.length) return;
    const dir = new THREE.Vector3(), hit = new Set<THREE.Mesh>();
    for (const p of target.points) {
      dir.copy(p).sub(cam);
      const len = dir.length();
      if (len < 0.05) continue;
      this.ray.set(cam, dir.divideScalar(len));
      this.ray.near = 0.02; this.ray.far = len - 0.015;
      for (const h of this.ray.intersectObjects(cands, false)) hit.add(h.object as THREE.Mesh);
    }
    // whatever touches a hit piece goes with it (one step, a few pieces at most)
    const grown = [...hit].map((m) => boxes.get(m)!.clone().expandByScalar(0.02));
    let extra = 0;
    for (const m of cands) {
      if (hit.has(m) || extra >= 24) continue;
      const b = boxes.get(m)!;
      if (!grown.some((g) => g.intersectsBox(b))) continue;
      b.getSize(this.size);
      if (b.min.y > target.surfaceY + 0.1 || this.size.x * this.size.z < 0.004) { hit.add(m); extra++; }
    }
    for (const m of hit) { this.hidden.set(m, m.layers.mask); m.layers.set(HIDE_LAYER); }
    const named = (o: THREE.Object3D) => { let p: THREE.Object3D | null = o; while (p && !p.name) p = p.parent; return p?.name || '?'; };
    this.names = [...new Set([...hit].map(named))];
  }

  restore() {
    for (const [m, mask] of this.hidden) m.layers.mask = mask;
    this.hidden.clear(); this.names = [];
  }
}

/** Points just above a surface (grid u × v, inset from the edges) — what a shot of it must see. */
export function surfacePoints(s: { at(u: number, v: number, out?: THREE.Vector3): THREE.Vector3; normal: THREE.Vector3 }, nu: number, nv: number, lift: number, inset = 0.04): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const u = inset + (1 - 2 * inset) * (nu === 1 ? 0.5 : i / (nu - 1)), v = inset + (1 - 2 * inset) * (nv === 1 ? 0.5 : j / (nv - 1));
    out.push(s.at(u, v).addScaledVector(s.normal, lift));
  }
  return out;
}
