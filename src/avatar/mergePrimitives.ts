// Load-time draw-call merge for skinned primitives that share a material (VRoid hair: 100+ primitives -> 1 mesh).
// Keep this file ASCII-only.
//
// A glTF mesh with N primitives loads as N sibling SkinnedMeshes. VRoid splits hair into ~100 primitives that all use
// ONE material, so every frame pays ~100 draw calls (per scene pass: main, shadow, glow) plus ~100 matrix updates and
// bindMatrixInverse inverts. Merging them into one SkinnedMesh bound to the same skeleton + bindMatrix draws the same
// triangles with the same shader, uniforms and skinning (every vertex skins to a bit-identical position).
//
// It is NOT bit-exact on screen, at any anti-aliasing setting. Where two hair cards overlap at exactly the same depth,
// the one drawn last wins (depthFunc LessEqual). Separate primitives are sorted front to back by their bounding-sphere
// centre, so that winner depended on the camera; the merged mesh draws in primitive (index) order, the same from every
// angle. Measured in src/stage/Stage.ts over 10 views at 160x240 (384,000 px): kairo / mirelle 6-7 px differ with no
// MSAA (tier low), 13-39 px with MSAA x4; isolated hair pixels. Not visible; a different tie-break, not a worse one.
//
// What is merged (everything must match, otherwise the mesh is left alone):
//   - primitives of ONE glTF mesh (`sourceOf`), so a named glTF node never disappears (costume `hides`, name lookups)
//   - same parent, skeleton, bind mode, bindMatrix (eps) and local transform (eps)
//   - same material object(s); none transparent, none with depthWrite / depthTest off, no blending, no stencil writes
//     (transparent sorting and blending order are therefore unchanged)
//   - same attribute set (names, array types, item sizes, normalized), index-ness, renderOrder, layers, visibility,
//     shadow flags, frustumCulled, userData; no morph targets, no children, default drawRange, no custom render hooks
//   - array materials only with full-range groups (one per material, in order), e.g. three-vrm MToon outlines
//   - an optional caller key (`extraKey`) - AvatarRuntime passes which profile name references match the mesh
// Run it AFTER any load-time pass that judges each mesh on its own (per-mesh centroids, normal-orientation tests,
// welds): one merged mesh can give that pass a different answer than its parts did. AvatarRuntime therefore merges
// after the costume fit (src/avatar/costumeFit.ts), not before it.
// Kill switch: localStorage vtp.mergePrims = '0' (checked by the caller via mergeEnabled()).

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface MergeGroup {
  /** the new mesh (named after the first source primitive, in its place among the parent's children) */
  into: THREE.SkinnedMesh;
  /** the primitives it replaces (removed from the scene) */
  from: THREE.SkinnedMesh[];
}

export interface MergeReport {
  groups: MergeGroup[];
  /** source primitives folded into merged meshes */
  primitives: number;
  /** merged meshes created (draw calls saved per pass = primitives - meshes) */
  meshes: number;
  ms: number;
}

export interface MergeOptions {
  /** The glTF source of a mesh (e.g. its glTF mesh index). Only meshes with the SAME non-null source merge;
   *  null / undefined = leave this mesh alone. */
  sourceOf: (m: THREE.SkinnedMesh) => string | number | null | undefined;
  /** Extra grouping key: only meshes with equal keys merge. */
  extraKey?: (m: THREE.SkinnedMesh) => string;
  /** Tolerance for bindMatrix / local matrix comparison (default 1e-6). */
  eps?: number;
}

/** localStorage vtp.mergePrims = '0' turns the merge off (the old one-mesh-per-primitive path). */
export function mergeEnabled(): boolean {
  try { return globalThis.localStorage?.getItem('vtp.mergePrims') !== '0'; } catch { return true; }
}

const matsOf = (m: THREE.Mesh): THREE.Material[] => (Array.isArray(m.material) ? m.material : [m.material]);
const fullCount = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.attributes.position?.count ?? 0);

function jsonKey(v: unknown): string | null {
  try { return JSON.stringify(v ?? {}); } catch { return null; }
}

/** Why a mesh can't take part (null = it can). Exported for the unit test. */
export function unmergeableReason(m: THREE.SkinnedMesh): string | null {
  if (!m.isSkinnedMesh || !m.skeleton) return 'not skinned';
  if (!m.parent) return 'no parent';
  if (m.children.length) return 'has children';
  const g = m.geometry;
  if (!g?.isBufferGeometry || !g.attributes.position) return 'no geometry';
  if (m.morphTargetInfluences?.length || Object.values(g.morphAttributes).some((a) => a?.length)) return 'morph targets';
  if (g.drawRange.start !== 0 || g.drawRange.count !== Infinity) return 'draw range';
  for (const a of Object.values(g.attributes)) if ((a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) return 'interleaved';
  if (Object.prototype.hasOwnProperty.call(m, 'onBeforeRender') || Object.prototype.hasOwnProperty.call(m, 'onAfterRender')) return 'render hook';
  if (m.customDepthMaterial || m.customDistanceMaterial) return 'custom depth material';
  const mats = matsOf(m);
  if (!mats.length || mats.some((x) => !x)) return 'no material';
  for (const x of mats) {
    if (x.transparent) return 'transparent';
    if (!x.depthWrite || !x.depthTest) return 'depth off';
    if (x.blending !== THREE.NormalBlending && x.blending !== THREE.NoBlending) return 'blending';
    if (x.stencilWrite) return 'stencil';
  }
  if (Array.isArray(m.material)) {
    // only the "every material draws the whole primitive" layout (three-vrm MToon outlines) can be re-created
    const n = fullCount(g);
    if (g.groups.length !== mats.length) return 'groups';
    for (let i = 0; i < g.groups.length; i++) {
      const gr = g.groups[i];
      if (gr.start !== 0 || gr.count < n || (gr.materialIndex ?? 0) !== i) return 'groups';
    }
  } else if (g.groups.length) return 'groups';
  return null;
}

function attrSig(g: THREE.BufferGeometry): string {
  return Object.keys(g.attributes).sort().map((k) => {
    const a = g.attributes[k] as THREE.BufferAttribute;
    return `${k}:${a.array.constructor.name}:${a.itemSize}:${a.normalized ? 1 : 0}:${a.gpuType}:${a.usage}`;
  }).join(',') + (g.index ? '|i' : '|n');
}

const near = (a: ArrayLike<number>, b: ArrayLike<number>, eps: number) => {
  for (let i = 0; i < 16; i++) if (Math.abs(a[i] - b[i]) > eps * Math.max(1, Math.abs(a[i]))) return false;
  return true;
};

/** Merge sibling skinned primitives that share a material (see the header). Mutates the scene graph under `root`.
 *  Phase 1 builds every merged geometry without touching the scene; phase 2 swaps the meshes. */
export function mergeSkinnedPrimitives(root: THREE.Object3D, opts: MergeOptions): MergeReport {
  const t0 = performance.now();
  const eps = opts.eps ?? 1e-6;
  const ids = new Map<object, number>();
  const idOf = (o: object) => { let v = ids.get(o); if (v === undefined) { v = ids.size; ids.set(o, v); } return v; };

  // ---- 1. bucket candidates by everything that must be identical
  const buckets = new Map<string, THREE.SkinnedMesh[]>();
  const candidates: THREE.SkinnedMesh[] = [];
  root.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) candidates.push(o as THREE.SkinnedMesh); });
  for (const m of candidates) {
    if (unmergeableReason(m)) continue;
    const src = opts.sourceOf(m);
    if (src === null || src === undefined) continue;
    const ud = jsonKey(m.userData), gud = jsonKey(m.geometry.userData);
    if (ud === null || gud === null) continue;
    if (m.matrixAutoUpdate) m.updateMatrix();
    const key = [
      idOf(m.parent!), String(src), idOf(m.skeleton), m.bindMode, matsOf(m).map(idOf).join('+'), Array.isArray(m.material) ? 'arr' : 'one',
      attrSig(m.geometry), m.renderOrder, m.layers.mask, m.visible, m.castShadow, m.receiveShadow, m.frustumCulled,
      m.matrixAutoUpdate, m.matrixWorldAutoUpdate, ud, gud, opts.extraKey?.(m) ?? '',
    ].join('|');
    let list = buckets.get(key);
    if (!list) buckets.set(key, (list = []));
    list.push(m);
  }

  // ---- 2. split buckets by bindMatrix + local matrix (eps), then merge geometries (no scene changes yet)
  const plans: { from: THREE.SkinnedMesh[]; geometry: THREE.BufferGeometry }[] = [];
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    const clusters: THREE.SkinnedMesh[][] = [];
    for (const m of list) {
      const c = clusters.find((cl) => near(cl[0].bindMatrix.elements, m.bindMatrix.elements, eps) && near(cl[0].matrix.elements, m.matrix.elements, eps));
      if (c) c.push(m); else clusters.push([m]);
    }
    for (const from of clusters) {
      if (from.length < 2) continue;
      const geometry = mergeGeometries(from.map((m) => m.geometry), false);
      if (!geometry) continue;
      const first = from[0];
      if (Array.isArray(first.material)) {
        const n = fullCount(geometry);
        for (let i = 0; i < first.material.length; i++) geometry.addGroup(0, n, i);
      }
      geometry.name = first.geometry.name;
      geometry.userData = JSON.parse(jsonKey(first.geometry.userData)!);
      plans.push({ from, geometry });
    }
  }

  // ---- 3. swap: one SkinnedMesh per group, in the first primitive's place, bound to the same skeleton + bindMatrix
  const groups: MergeGroup[] = [];
  let primitives = 0;
  for (const { from, geometry } of plans) {
    const first = from[0];
    const parent = first.parent!;
    const sm = new THREE.SkinnedMesh(geometry, first.material);
    sm.name = first.name;
    sm.position.copy(first.position); sm.quaternion.copy(first.quaternion); sm.scale.copy(first.scale);
    sm.matrix.copy(first.matrix);
    sm.matrixAutoUpdate = first.matrixAutoUpdate; sm.matrixWorldAutoUpdate = first.matrixWorldAutoUpdate;
    sm.visible = first.visible; sm.renderOrder = first.renderOrder; sm.layers.mask = first.layers.mask;
    sm.castShadow = first.castShadow; sm.receiveShadow = first.receiveShadow; sm.frustumCulled = first.frustumCulled;
    sm.userData = JSON.parse(jsonKey(first.userData)!);
    sm.bindMode = first.bindMode;
    sm.bind(first.skeleton, first.bindMatrix);
    const at = parent.children.indexOf(first);
    parent.add(sm);
    parent.children.splice(parent.children.length - 1, 1);
    parent.children.splice(at, 0, sm);
    // a new object's matrixWorld is identity until something updates the tree; the rest of AvatarRuntime.build() reads
    // world positions before the first frame does (sampleSkinColor for procedural eyes: a VRM0 avatar is turned 180
    // degrees, so its merged back hair sat in front of the face and the eyelids took the hair colour). Review of beta.9.
    // The parents first, then its own world matrix + (attached bind mode) bindMatrixInverse, as every frame does.
    parent.updateWorldMatrix(true, false);
    sm.updateMatrixWorld(true);
    for (const m of from) parent.remove(m);
    groups.push({ into: sm, from });
    primitives += from.length;
  }
  return { groups, primitives, meshes: groups.length, ms: performance.now() - t0 };
}

const sanitize = (n: string) => THREE.PropertyBinding.sanitizeNodeName(n ?? '');

/** Grouping key from name references (costume `hides`, look.hairMeshes, look.surfaces keys: exact names or
 *  `/regex/flags`): the indices of the references that match a mesh's name. Meshes merge only with meshes that match
 *  the same references, so a name-based lookup finds the merged mesh exactly when it found its parts. */
export function nameRefKey(refs: string[]): (o: THREE.Object3D) => string {
  const tests: ((names: string[]) => boolean)[] = [];
  for (const r of refs) {
    if (typeof r !== 'string' || !r) continue;
    const rx = /^\/(.+)\/([a-z]*)$/.exec(r);
    if (rx) {
      let re: RegExp | null = null;
      try { re = new RegExp(rx[1], rx[2] || 'i'); } catch { re = null; }
      if (re) { const x = re; tests.push((names) => names.some((n) => x.test(n))); continue; }
    }
    const want = new Set([r, sanitize(r)]);
    tests.push((names) => names.some((n) => want.has(n)));
  }
  if (!tests.length) return () => '';
  return (o) => {
    const names: string[] = [];
    for (const n of [o.name, o.userData?.name as unknown]) if (typeof n === 'string' && n) names.push(n, sanitize(n));
    const hits: number[] = [];
    tests.forEach((t, i) => { if (t(names)) hits.push(i); });
    return hits.join(',');
  };
}
