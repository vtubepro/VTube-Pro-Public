// Surface patches: lift the skin triangles around a marker into a new mesh that rides the same
// skeleton + morphs, with a 2D (u,v) parameterization in a tangent frame at the marker.
// Procedural mouths / decal eyes are drawn on patches by shaders, so they conform to ANY surface
// (frog snout, anime face, robot visor) without touching the model's topology.

import * as THREE from 'three';
import type { SurfaceMarker } from '../../shared/types.ts';
import { fullIndex } from './lod/fullIndex.ts';

export interface FaceFrame {
  /** World (at rest) position + orthonormal frame: T = avatar-left, B = up along surface, N = out. */
  c: THREE.Vector3;
  T: THREE.Vector3;
  B: THREE.Vector3;
  N: THREE.Vector3;
}

/** Build a tangent frame at a marker. `anchor` defines avatar space (its +X is avatar-left, +Y up). */
export function faceFrame(marker: SurfaceMarker, modelRoot: THREE.Object3D, anchor: THREE.Object3D): FaceFrame {
  modelRoot.updateWorldMatrix(true, true);
  const c = new THREE.Vector3(...marker.position).applyMatrix4(modelRoot.matrixWorld);
  const nm = new THREE.Matrix3().getNormalMatrix(modelRoot.matrixWorld);
  const N = new THREE.Vector3(...marker.normal).applyMatrix3(nm).normalize();
  const aq = anchor.getWorldQuaternion(new THREE.Quaternion());
  const left = new THREE.Vector3(1, 0, 0).applyQuaternion(aq);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(aq);
  // T: avatar-left projected onto the tangent plane (fallback: up × N when N ≈ ±left)
  let T = left.clone().sub(N.clone().multiplyScalar(left.dot(N)));
  if (T.lengthSq() < 1e-4) T = up.clone().cross(N);
  T.normalize();
  const B = N.clone().cross(T).normalize(); // points "up" along the surface
  if (B.dot(up) < 0 && Math.abs(N.dot(up)) < 0.9) { B.negate(); T.negate(); }
  return { c, T, B, N };
}

export interface CollectOptions {
  /**
   * Include worn costume meshes (userData.vtpCostume). Default false: face work (mouth/eye patches,
   * generated morphs, skin sampling, marker picking) must never land on clothing. Jiggle weights and
   * stats pass true.
   */
  costumes?: boolean;
}

export function collectMeshes(root: THREE.Object3D, opts: CollectOptions = {}): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || m.userData.vtpOutline || m.userData.vtpGenerated || m.userData.vtpHidden || !m.geometry?.attributes.position) return;
    if (m.userData.vtpCostume && !opts.costumes) return;
    out.push(m);
  });
  return out;
}

export interface PatchOptions {
  radius: number;
  /** World units to lift the patch off the skin (fights z-fighting). */
  lift: number;
  /** Reject triangles facing away from the marker normal (dot below this). */
  minFacing: number;
  /** Scale for (u,v): 1 unit = this many world units. */
  uvScale: number;
  /** Also patch facial hair / `_nopatch` meshes (the food-mess layer: sauce in the moustache is the joke). */
  includeHair?: boolean;
  /** Optional per-source-mesh vertex filter (e.g. "skinned to the hand bones"); a triangle needs all 3. */
  vertexFilter?: (src: THREE.Mesh) => ((i: number) => boolean) | null;
}

/** Extract patch meshes (one per source mesh touched). Must be called with the rig at rest pose. */
/** Facial hair / overhanging accessories (a moustache over the upper lip) must not receive the drawn
 *  mouth — it belongs on the skin underneath. They still get the generated mouth morphs, so a
 *  moustache rides the smile. Opt out by name or with the glTF extra `vtpNoPatch`. */
const NO_PATCH = /mustache|moustache|beard|_nopatch/i;
export function excludedFromPatch(m: THREE.Object3D): boolean {
  for (let o: THREE.Object3D | null = m; o; o = o.parent) {
    if (o.userData?.vtpNoPatch || NO_PATCH.test(o.name)) return true;
    if ((o as THREE.Bone).isBone || o.type === 'Scene') break;
  }
  return false;
}

/**
 * Does the mesh come nowhere near the patch sphere (frame.c, radius)? Checked on the mesh's own position bounds,
 * moved to world space, so a whole body / hair / prop mesh far from the face is skipped without touching its
 * vertices or triangles. Conservative: a tiny margin covers the float32 rounding of the per-vertex world positions,
 * so this never skips a mesh that has a vertex inside the radius.
 */
export function meshFarFromFrame(pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, M: THREE.Matrix4, c: THREE.Vector3, radius: number): boolean {
  const n = pos.count;
  if (!n) return true;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  if (!(Number.isFinite(x0 + y0 + z0 + x1 + y1 + z1))) return false;    // odd data: do the full scan
  const e = M.elements;
  // the 8 box corners, moved to world space (affine matrices; anything else: do the full scan)
  if (e[3] !== 0 || e[7] !== 0 || e[11] !== 0 || e[15] !== 1) return false;
  let wx0 = Infinity, wy0 = Infinity, wz0 = Infinity, wx1 = -Infinity, wy1 = -Infinity, wz1 = -Infinity;
  for (let k = 0; k < 8; k++) {
    const x = k & 1 ? x1 : x0, y = k & 2 ? y1 : y0, z = k & 4 ? z1 : z0;
    const wx = e[0] * x + e[4] * y + e[8] * z + e[12], wy = e[1] * x + e[5] * y + e[9] * z + e[13], wz = e[2] * x + e[6] * y + e[10] * z + e[14];
    if (wx < wx0) wx0 = wx; if (wx > wx1) wx1 = wx;
    if (wy < wy0) wy0 = wy; if (wy > wy1) wy1 = wy;
    if (wz < wz0) wz0 = wz; if (wz > wz1) wz1 = wz;
  }
  const mag = Math.max(Math.abs(wx0), Math.abs(wx1), Math.abs(wy0), Math.abs(wy1), Math.abs(wz0), Math.abs(wz1), Math.abs(c.x), Math.abs(c.y), Math.abs(c.z));
  const margin = 1e-5 * (1 + mag);
  const dx = Math.max(wx0 - c.x, 0, c.x - wx1), dy = Math.max(wy0 - c.y, 0, c.y - wy1), dz = Math.max(wz0 - c.z, 0, c.z - wz1);
  const reach = radius + margin;
  return dx * dx + dy * dy + dz * dz > reach * reach;
}

/**
 * The triangles of `src` that belong in a patch around `frame`, as a flat list of vertex indices (3 per triangle),
 * plus every vertex's world position (rest pose). Plain scalar math: no per-triangle objects.
 */
export function selectPatchTriangles(src: THREE.Mesh, frame: FaceFrame, opts: PatchOptions): { keep: number[]; world: Float32Array } | null {
  const vf = opts.vertexFilter?.(src) ?? null;
  src.updateWorldMatrix(true, false);
  const g = src.geometry as THREE.BufferGeometry;
  const pos = g.attributes.position as THREE.BufferAttribute;
  const M = src.matrixWorld;
  // whole-mesh early-out: nothing of this mesh is inside the patch radius
  if (meshFarFromFrame(pos, M, frame.c, opts.radius)) return null;
  const idx = fullIndex(g);   // (the full triangle list, whatever Avatar detail level is drawn)
  const triCount = idx ? idx.count / 3 : pos.count / 3;
  const r2 = opts.radius * opts.radius;
  // world positions: the same arithmetic as Vector3.applyMatrix4, written out
  const e = M.elements;
  const world = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
    world[i * 3] = (e[0] * x + e[4] * y + e[8] * z + e[12]) * w;
    world[i * 3 + 1] = (e[1] * x + e[5] * y + e[9] * z + e[13]) * w;
    world[i * 3 + 2] = (e[2] * x + e[6] * y + e[10] * z + e[14]) * w;
  }
  const cx = frame.c.x, cy = frame.c.y, cz = frame.c.z, N = frame.N;
  const ia = idx ? (idx.array as ArrayLike<number>) : null;
  const keep: number[] = [];
  for (let t = 0; t < triCount; t++) {
    const i0 = ia ? ia[t * 3] : t * 3, i1 = ia ? ia[t * 3 + 1] : t * 3 + 1, i2 = ia ? ia[t * 3 + 2] : t * 3 + 2;
    const a0 = i0 * 3, a1 = i1 * 3, a2 = i2 * 3;
    let dx = world[a0] - cx, dy = world[a0 + 1] - cy, dz = world[a0 + 2] - cz;
    let near = dx * dx + dy * dy + dz * dz < r2;
    if (!near) { dx = world[a1] - cx; dy = world[a1 + 1] - cy; dz = world[a1 + 2] - cz; near = dx * dx + dy * dy + dz * dz < r2; }
    if (!near) { dx = world[a2] - cx; dy = world[a2 + 1] - cy; dz = world[a2 + 2] - cz; near = dx * dx + dy * dy + dz * dz < r2; }
    if (!near) continue;
    if (vf && !(vf(i0) && vf(i1) && vf(i2))) continue;
    // face normal = (b - a) x (c - a), same operation order as Vector3.cross / normalize
    const ux = world[a1] - world[a0], uy = world[a1 + 1] - world[a0 + 1], uz = world[a1 + 2] - world[a0 + 2];
    const vx = world[a2] - world[a0], vy = world[a2 + 1] - world[a0 + 1], vz = world[a2 + 2] - world[a0 + 2];
    let fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    const lsq = fx * fx + fy * fy + fz * fz;
    if (lsq < 1e-14) continue;
    const inv = 1 / (Math.sqrt(lsq) || 1);
    fx *= inv; fy *= inv; fz *= inv;
    if (fx * N.x + fy * N.y + fz * N.z < opts.minFacing) continue;
    keep.push(i0, i1, i2);
  }
  return { keep, world };
}

export function buildPatches(meshes: THREE.Mesh[], frame: FaceFrame, opts: PatchOptions, material: THREE.Material): THREE.Mesh[] {
  const patches: THREE.Mesh[] = [];
  const pw = new THREE.Vector3();
  for (const src of meshes) {
    if (!opts.includeHair && excludedFromPatch(src)) continue;
    const sel = selectPatchTriangles(src, frame, opts);
    if (!sel || !sel.keep.length) continue;
    const { keep, world } = sel;
    const g = src.geometry as THREE.BufferGeometry;
    const nrm = g.attributes.normal as THREE.BufferAttribute | undefined;
    const M = src.matrixWorld;
    const inv = new THREE.Matrix4().copy(M).invert();
    const nmW = new THREE.Matrix3().getNormalMatrix(M);

    // Compact vertices
    const remap = new Map<number, number>();
    const order: number[] = [];
    const newIndex = keep.map((i) => {
      let j = remap.get(i);
      if (j === undefined) { j = order.length; remap.set(i, j); order.push(i); }
      return j;
    });
    const geo = new THREE.BufferGeometry();
    const n = order.length;
    const P = new Float32Array(n * 3), N = new Float32Array(n * 3), UV = new Float32Array(n * 2);
    const liftLocal = new THREE.Vector3();
    for (let k = 0; k < n; k++) {
      const i = order[k];
      pw.fromArray(world, i * 3);
      const d = pw.clone().sub(frame.c);
      UV[k * 2] = d.dot(frame.T) / opts.uvScale;
      UV[k * 2 + 1] = d.dot(frame.B) / opts.uvScale;
      // lift along the vertex normal (world) then back to local
      const vn = nrm ? new THREE.Vector3().fromBufferAttribute(nrm, i).applyMatrix3(nmW).normalize() : frame.N;
      liftLocal.copy(pw).addScaledVector(vn, opts.lift).applyMatrix4(inv);
      P[k * 3] = liftLocal.x; P[k * 3 + 1] = liftLocal.y; P[k * 3 + 2] = liftLocal.z;
      if (nrm) { N[k * 3] = nrm.getX(i); N[k * 3 + 1] = nrm.getY(i); N[k * 3 + 2] = nrm.getZ(i); }
    }
    geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    geo.setAttribute('patchUv', new THREE.BufferAttribute(UV, 2));
    for (const name of ['skinIndex', 'skinWeight'] as const) {
      const src_ = g.attributes[name] as THREE.BufferAttribute | undefined;
      if (!src_) continue;
      const Arr = (src_.array as unknown as { constructor: new (n: number) => Float32Array }).constructor;
      const arr = new Arr(n * 4);
      for (let k = 0; k < n; k++) for (let c = 0; c < 4; c++) arr[k * 4 + c] = src_.array[order[k] * 4 + c];
      geo.setAttribute(name, new THREE.BufferAttribute(arr, 4, src_.normalized));
    }
    // carry morph targets (e.g. our generated jaw/smile shapes) so the patch deforms with the skin
    const morphs = g.morphAttributes.position;
    if (morphs?.length) {
      // glTF morphs arrive unnamed (GLTFLoader names them only in the mesh's morphTargetDictionary): take the
      // names from there, or syncPatchMorphs can't match them and the patch never follows the face's own shapes
      const names: string[] = [];
      for (const [k, i] of Object.entries(src.morphTargetDictionary ?? {})) names[i] = k;
      // Only targets that move at least one vertex of THIS patch are carried (relative targets only: an absolute one
      // always pulls toward the unlifted skin). Everything resolves by name (syncPatchMorphs), so the shorter list
      // changes nothing on screen; it just keeps the patch's morph texture / shader loop small.
      const carried: THREE.BufferAttribute[] = [];
      morphs.forEach((m, mi) => {
        const src_ = m.array as Float32Array;
        const arr = new Float32Array(n * 3);
        let any = g.morphTargetsRelative !== true;
        for (let k = 0; k < n; k++) for (let c = 0; c < 3; c++) {
          const v = src_[order[k] * 3 + c];
          arr[k * 3 + c] = v;
          if (v !== 0) any = true;
        }
        if (!any) return;
        const at = new THREE.BufferAttribute(arr, 3); at.name = m.name || names[mi] || String(mi);
        carried.push(at);
      });
      if (carried.length) geo.morphAttributes.position = carried;
      if (carried.length) geo.morphTargetsRelative = g.morphTargetsRelative;
    }
    geo.setIndex(newIndex);
    geo.computeBoundingSphere();

    let patch: THREE.Mesh;
    if ((src as THREE.SkinnedMesh).isSkinnedMesh && geo.attributes.skinIndex) {
      const sm = src as THREE.SkinnedMesh;
      const sp = new THREE.SkinnedMesh(geo, material);
      sp.bind(sm.skeleton, sm.bindMatrix);
      patch = sp;
    } else {
      patch = new THREE.Mesh(geo, material);
    }
    patch.name = `${src.name}_patch`;
    patch.userData.vtpGenerated = true;
    patch.userData.vtpNoToon = true;
    patch.userData.source = src;
    patch.position.copy(src.position); patch.quaternion.copy(src.quaternion); patch.scale.copy(src.scale);
    patch.frustumCulled = false;
    patch.renderOrder = 2;
    patch.updateMorphTargets();
    src.parent?.add(patch);
    patches.push(patch);
  }
  return patches;
}

/** Keep a patch's morph weights locked to its source mesh's (matched by morph name). */
export function syncPatchMorphs(patch: THREE.Mesh) {
  const src = patch.userData.source as THREE.Mesh | undefined;
  if (!src?.morphTargetInfluences || !patch.morphTargetInfluences || !patch.morphTargetDictionary || !src.morphTargetDictionary) return;
  for (const name in patch.morphTargetDictionary) {
    const si = src.morphTargetDictionary[name];
    if (si !== undefined) patch.morphTargetInfluences[patch.morphTargetDictionary[name]] = src.morphTargetInfluences[si];
  }
}

// ---------------- generated morph targets ----------------

export type DisplaceFn = (d: THREE.Vector3, u: number, v: number, n: number) => THREE.Vector3 | null;

/**
 * Add a morph target to every mesh near the frame, computed by `fn` in world space at rest.
 * `d` = world offset from the frame centre, (u,v,n) = its coordinates in the frame (world units).
 */
export function addGeneratedMorph(meshes: THREE.Mesh[], frame: FaceFrame, name: string, radius: number, fn: DisplaceFn) {
  const pw = new THREE.Vector3();
  const touched: THREE.Mesh[] = [];
  for (const mesh of meshes) {
    mesh.updateWorldMatrix(true, false);
    const g = mesh.geometry as THREE.BufferGeometry;
    const pos = g.attributes.position as THREE.BufferAttribute;
    const M = mesh.matrixWorld;
    const invLinear = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().copy(M).invert());
    const arr = new Float32Array(pos.count * 3);
    let any = false;
    for (let i = 0; i < pos.count; i++) {
      pw.fromBufferAttribute(pos, i).applyMatrix4(M);
      const d = pw.sub(frame.c);
      if (d.lengthSq() > radius * radius) continue;
      const disp = fn(d.clone(), d.dot(frame.T), d.dot(frame.B), d.dot(frame.N));
      if (!disp) continue;
      disp.applyMatrix3(invLinear);
      arr[i * 3] = disp.x; arr[i * 3 + 1] = disp.y; arr[i * 3 + 2] = disp.z;
      any = true;
    }
    if (!any) continue;
    const existing = g.morphAttributes.position ?? [];
    // glTF morphs arrive unnamed (GLTFLoader names them only in the mesh's dictionary): name them first, or the
    // updateMorphTargets() below rebuilds the dictionary as '0', '1', … and the model's own shapes (blink lids,
    // brows) stop being found by the expression driver
    const own = Object.entries(mesh.morphTargetDictionary ?? {});
    for (const [k, i] of own) {
      if (existing[i] && !existing[i].name) existing[i].name = k;
      const nm = g.morphAttributes.normal?.[i];
      if (nm && !nm.name) nm.name = k;
    }
    if (existing.length && !g.morphTargetsRelative) {
      // absolute morphs: convert our delta into absolute positions
      for (let i = 0; i < pos.count; i++) { arr[i * 3] += pos.getX(i); arr[i * 3 + 1] += pos.getY(i); arr[i * 3 + 2] += pos.getZ(i); }
    } else g.morphTargetsRelative = true;
    const at = new THREE.BufferAttribute(arr, 3); at.name = name;
    g.morphAttributes.position = [...existing.filter((m) => m.name !== name), at];
    if (g.morphAttributes.normal) {
      const zero = new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3); zero.name = name;
      if (!g.morphTargetsRelative) (zero.array as Float32Array).set((g.attributes.normal as THREE.BufferAttribute).array as Float32Array);
      g.morphAttributes.normal = [...g.morphAttributes.normal.filter((m) => m.name !== name), zero];
    }
    // preserve existing influences across updateMorphTargets()
    const prev = mesh.morphTargetInfluences ? [...mesh.morphTargetInfluences] : [];
    const prevDict = mesh.morphTargetDictionary ? { ...mesh.morphTargetDictionary } : {};
    mesh.updateMorphTargets();
    for (const k in prevDict) {
      const ni = mesh.morphTargetDictionary![k];
      if (ni !== undefined) mesh.morphTargetInfluences![ni] = prev[prevDict[k]] ?? 0;
    }
    touched.push(mesh);
  }
  return touched;
}

export function setMorph(mesh: THREE.Mesh, name: string, w: number) {
  const i = mesh.morphTargetDictionary?.[name];
  if (i !== undefined && mesh.morphTargetInfluences) mesh.morphTargetInfluences[i] = w;
}
