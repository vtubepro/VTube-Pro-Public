// BVH builds for model loads (one per page, created lazily by src/avatar/loadSlicer.ts): the costume fit's body and
// costume BVHs (100-200 ms each on a detailed avatar, one piece of work three-mesh-bvh cannot cut) are built here while
// the page keeps drawing. Gets copies of a geometry's positions + index, answers MeshBVH.serialize (its reordered index
// included). Nothing is kept between jobs.
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

interface BvhJob { id: number; position: Float32Array; index: Uint32Array | null; options: { maxLeafSize: number } }
const ctx = self as unknown as { onmessage: ((e: MessageEvent<BvhJob>) => void) | null; postMessage(m: unknown, t?: Transferable[]): void };

ctx.onmessage = (e) => {
  const { id, position, index, options } = e.data;
  try {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(position, 3));
    if (index) g.setIndex(new THREE.BufferAttribute(index, 1));
    const bvh = new MeshBVH(g, options);
    const s = MeshBVH.serialize(bvh, { cloneBuffers: false });
    const t: Transferable[] = [...s.roots.map((r) => r as ArrayBuffer)];
    if (s.index) t.push((s.index as Uint32Array).buffer as ArrayBuffer);
    ctx.postMessage({ id, serialized: s }, t);
  } catch (err) {
    ctx.postMessage({ id, error: (err as Error)?.message ?? String(err) });
  }
};
