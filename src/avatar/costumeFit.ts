// Costume fit pass: makes ANY worn costume (builtin, imported, AI-generated) clip-free at load time.
//
// Runs once, in the REST pose (bind space), right after the costume is rebound onto the base
// skeleton (see costumes.ts) and before face patches / generated morphs / toon outlines are built:
//
//   1. Penetration push-out — every costume vertex that is inside the base body (or closer than
//      `margin`) is moved outward along the body normal. The signed distance is remapped
//      MONOTONICALLY ([-maxDepth, 1.5·margin] → [margin, 1.5·margin]) so layered garments (a shell's
//      inner + outer skins, a belt over a shirt) keep their stacking order instead of collapsing onto
//      one surface. The displacement field is Laplacian-smoothed over welded neighbours (pushed
//      minimums are re-enforced after each pass) so pushed regions don't dent or crease. Rigid
//      components (props, hats, buckles: one bone at ≥ 98 %) and anything buried deeper than
//      maxDepth (canes through hands, hats sunk into heads — deliberate) are left alone.
//   2. Hide covered body — each base-body vertex casts 4 rays (normal + 3 jittered at 25°) against
//      the costume; if all hit costume surface within 4 % of the avatar height, and that surface is
//      skinned to the SAME body part (histogram-intersection of humanoid-anchored weights ≥ 0.35, so
//      a hanging sleeve never hides the torso side it happens to cover at rest), the vertex is
//      covered. Triangles whose 3 corners are covered are dropped from the body's index (the full
//      index is kept on geometry.userData.vtpFullIndex and restore() puts it back). Never inside the
//      face keep-out spheres; hand / foot groups are hidden only when (almost) fully covered.
//
// Outlines (toon.ts clones the geometry → reduced index), mouth / eye patches (face region is kept)
// and generated morphs (per-vertex, index-independent) all keep working after the pass.

import * as THREE from 'three';
import { INTERSECTED, NOT_INTERSECTED, type MeshBVH } from 'three-mesh-bvh';
import { runSync, type Steps } from './loadSlicer.ts';
import { collectMeshes } from './surfacePatch.ts';

export interface FitSphere { center: THREE.Vector3; radius: number }

export interface FitOptions {
  /** Clearance between body and costume, as a FRACTION of avatar height (default 0.006; 0 = no push). */
  margin?: number;
  /** Hide body triangles fully covered by the costume (default true). */
  hideBody?: boolean;
  /** World-space spheres whose body triangles are never hidden (mouth patch, eyes). */
  keepVisible?: FitSphere[];
  /** World-space spheres whose body vertices always count as covered (keepVisible still wins). */
  hideInside?: FitSphere[];
  /** Same, given in base-model (bind) space + a bone: mapped through that bone's skin transform at rest, so the
   *  sphere lands exactly where the skinned body renders (independent of grounding offsets). */
  hideInsideBind?: { center: THREE.Vector3; radius: number; bone: string }[];
  /** Raw humanoid bone → role name ('head', 'leftHand', …): body-part identity for coverage. */
  anchors?: Map<THREE.Object3D, string>;
  /** Log prefix. */
  label?: string;
}

export interface FitReport {
  ms: number;
  pushMs: number;
  hideMs: number;
  height: number;
  /** World-units margin actually used. */
  margin: number;
  costumeVertices: number;
  verticesPushed: number;
  /** Inside / too close to the body but covered by another costume layer → left alone. */
  verticesTucked: number;
  /** Largest push (world units). */
  maxPush: number;
  meshesTouched: string[];
  bodyTris: number;
  hiddenTris: number;
  /** Hand / foot all-or-nothing groups: covered / total vertices, and whether they were hidden. */
  groups: Record<string, { covered: number; total: number; hidden: boolean }>;
}

export interface CostumeFit {
  report: FitReport;
  /** Put the base body's full index back (costume removed / switched). */
  restore(): void;
}

const EYEISH = /eye|iris|pupil|sclera|cornea|teeth|tooth|tongue|lash|brow|mouth/i;
const HANDFOOT = /^(left|right)(Hand|Thumb|Index|Middle|Ring|Little|Foot|Toes)/;

// ------------------------------------------------------------------ helpers

const isVisible = (o: THREE.Object3D) => { for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false; return true; };

/** Transform that maps this mesh's bind-space positions to world at rest (dominant bone). */
function restMatrix(m: THREE.Mesh): THREE.Matrix4 {
  const M = m.matrixWorld.clone();
  const sm = m as THREE.SkinnedMesh;
  const si = sm.geometry.attributes.skinIndex, sw = sm.geometry.attributes.skinWeight;
  if (!sm.isSkinnedMesh || !sm.skeleton || !si || !sw) return M;
  const acc = new Float64Array(sm.skeleton.bones.length);
  const step = Math.max(1, Math.floor(si.count / 3000));
  for (let i = 0; i < si.count; i += step) for (let k = 0; k < 4; k++) acc[si.getComponent(i, k)] += sw.getComponent(i, k);
  let b = 0;
  for (let i = 1; i < acc.length; i++) if (acc[i] > acc[b]) b = i;
  const bone = sm.skeleton.bones[b];
  if (!bone) return M;
  const B = new THREE.Matrix4().multiplyMatrices(bone.matrixWorld, sm.skeleton.boneInverses[b]);
  return M.multiply(sm.bindMatrixInverse).multiply(B).multiply(sm.bindMatrix);
}

/**
 * Rest-pose world positions as rendered. At rest every bone's skinning matrix is the same affine map,
 * so a sampled exact CPU-skinning check decides whether the fast single-matrix path is valid; any
 * disagreement (rest mismatch, morphs already on) falls back to exact per-vertex skinning.
 */
function worldPositions(m: THREE.Mesh): Float32Array {
  const pos = m.geometry.attributes.position;
  const out = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3(), a = new THREE.Vector3();
  const sm = m as THREE.SkinnedMesh;
  const skinned = sm.isSkinnedMesh && !!sm.skeleton && !!m.geometry.attributes.skinIndex;
  if (skinned) {
    const R = restMatrix(m);
    const step = Math.max(1, Math.floor(pos.count / 400));
    let ok = true;
    for (let i = 0; i < pos.count && ok; i += step) {
      sm.getVertexPosition(i, v); v.applyMatrix4(m.matrixWorld);
      a.fromBufferAttribute(pos, i).applyMatrix4(R);
      if (a.distanceToSquared(v) > 1e-10) ok = false;
    }
    if (ok) {
      const e = R.elements, p = pos.array as ArrayLike<number>;
      if (!(pos as unknown as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute && !pos.normalized) {
        for (let i = 0; i < pos.count; i++) {
          const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
          out[i * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
          out[i * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
          out[i * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
        }
        return out;
      }
    }
  }
  for (let i = 0; i < pos.count; i++) {
    if (skinned) sm.getVertexPosition(i, v); else v.fromBufferAttribute(pos, i);
    v.applyMatrix4(m.matrixWorld);
    out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
  }
  return out;
}

function triIndex(g: THREE.BufferGeometry): Uint32Array {
  if (g.index) return Uint32Array.from(g.index.array as ArrayLike<number>);
  const n = g.attributes.position.count;
  const a = new Uint32Array(n - (n % 3));
  for (let i = 0; i < a.length; i++) a[i] = i;
  return a;
}

/** Weld by quantized position → welded id per vertex. */
function weld(P: Float32Array, q: number) {
  const n = P.length / 3;
  const id = new Int32Array(n);
  const map = new Map<string, number>();
  let count = 0;
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(P[i * 3] / q)},${Math.round(P[i * 3 + 1] / q)},${Math.round(P[i * 3 + 2] / q)}`;
    let w = map.get(k);
    if (w === undefined) { w = count++; map.set(k, w); }
    id[i] = w;
  }
  return { id, count };
}

/** CSR adjacency over welded ids from triangles. */
function adjacency(tris: Uint32Array, id: Int32Array, count: number) {
  const sets: Set<number>[] = Array.from({ length: count }, () => new Set());
  for (let t = 0; t < tris.length; t += 3) {
    const a = id[tris[t]], b = id[tris[t + 1]], c = id[tris[t + 2]];
    if (a !== b) { sets[a].add(b); sets[b].add(a); }
    if (b !== c) { sets[b].add(c); sets[c].add(b); }
    if (a !== c) { sets[a].add(c); sets[c].add(a); }
  }
  const start = new Int32Array(count + 1);
  for (let i = 0; i < count; i++) start[i + 1] = start[i] + sets[i].size;
  const nb = new Int32Array(start[count]);
  for (let i = 0; i < count; i++) { let k = start[i]; for (const j of sets[i]) nb[k++] = j; }
  return { start, nb };
}

/** Per-vertex body-part weights: up to 4 (anchorId, weight), anchor = nearest humanoid ancestor bone. */
interface Anchored { ids: Int32Array; w: Float32Array }
function anchoredWeights(m: THREE.Mesh, anchorId: (o: THREE.Object3D) => number): Anchored {
  const n = m.geometry.attributes.position.count;
  const ids = new Int32Array(n * 4).fill(-1), w = new Float32Array(n * 4);
  const sm = m as THREE.SkinnedMesh;
  const si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight;
  if (!sm.isSkinnedMesh || !sm.skeleton || !si || !sw) {
    const a = anchorId(m);
    for (let i = 0; i < n; i++) { ids[i * 4] = a; w[i * 4] = 1; }
    return { ids, w };
  }
  const boneAnchor = sm.skeleton.bones.map((b) => (b ? anchorId(b) : -1));
  for (let i = 0; i < n; i++) {
    let used = 0;
    for (let k = 0; k < 4; k++) {
      const x = sw.getComponent(i, k);
      if (x <= 1e-4) continue;
      const a = boneAnchor[si.getComponent(i, k)] ?? -1;
      let j = 0;
      while (j < used && ids[i * 4 + j] !== a) j++;
      if (j === used) { ids[i * 4 + j] = a; used++; }
      w[i * 4 + j] += x;
    }
  }
  return { ids, w };
}

/** Histogram intersection of two anchored weight sets (unknown anchors count as a match). */
function similarity(A: Anchored, i: number, B: Anchored, j: number): number {
  let s = 0;
  for (let a = 0; a < 4; a++) {
    const ia = A.ids[i * 4 + a], wa = A.w[i * 4 + a];
    if (wa <= 0) continue;
    if (ia < 0) { s += wa; continue; }
    for (let b = 0; b < 4; b++) if (B.ids[j * 4 + b] === ia || B.ids[j * 4 + b] < 0) s += Math.min(wa, B.w[j * 4 + b]);
  }
  return s;
}

// ------------------------------------------------------------------ main

export function fitCostume(model: THREE.Object3D, costumeMeshes: THREE.Mesh[], opts: FitOptions = {}): CostumeFit {
  return runSync(fitCostumeSteps(model, costumeMeshes, opts));
}

/** fitCostume as steps (src/avatar/loadSlicer.ts): `yield` = a place to give the page back, `yield { bvh }` = build
 *  this BVH (in a worker on a live page). Same work, same result as the one-go version. */
export function* fitCostumeSteps(model: THREE.Object3D, costumeMeshes: THREE.Mesh[], opts: FitOptions = {}): Steps<CostumeFit> {
  const t0 = performance.now();
  model.updateWorldMatrix(true, true);
  const label = opts.label ?? 'costume';

  // ---- body-part anchors (nearest humanoid ancestor; else the top-most bone) ----
  const anchorIds = new Map<THREE.Object3D, number>();
  const anchorRole: string[] = [];
  const anchorCache = new Map<THREE.Object3D, number>();
  for (const [node, role] of opts.anchors ?? []) { anchorIds.set(node, anchorRole.length); anchorRole.push(role); }
  const anchorId = (o: THREE.Object3D): number => {
    const c = anchorCache.get(o);
    if (c !== undefined) return c;
    let r = -1;
    for (let p: THREE.Object3D | null = o; p; p = p.parent) { const a = anchorIds.get(p); if (a !== undefined) { r = a; break; } }
    anchorCache.set(o, r);
    return r;
  };

  // ---- body ----
  const bodies = collectMeshes(model).filter((m) => isVisible(m) && !EYEISH.test(m.name)
    && !(Array.isArray(m.material) ? m.material : [m.material]).every((mt) => mt?.transparent && mt.opacity < 0.5));
  interface Body { mesh: THREE.Mesh; P: Float32Array; N: Float32Array; tris: Uint32Array; off: number; aw: Anchored }
  const body: Body[] = [];
  let nV = 0, nT = 0;
  const box = new THREE.Box3();
  for (const mesh of bodies) {
    const P = worldPositions(mesh);
    const tris = triIndex(mesh.geometry);
    const R = restMatrix(mesh);
    const nm = new THREE.Matrix3().getNormalMatrix(R);
    const n = P.length / 3;
    const N = new Float32Array(n * 3);
    const src = mesh.geometry.attributes.normal as THREE.BufferAttribute | undefined;
    const v = new THREE.Vector3();
    if (src) for (let i = 0; i < n; i++) { v.fromBufferAttribute(src, i).applyMatrix3(nm).normalize(); N[i * 3] = v.x; N[i * 3 + 1] = v.y; N[i * 3 + 2] = v.z; }
    else {
      const tmp = new THREE.BufferGeometry(); tmp.setAttribute('position', new THREE.BufferAttribute(P, 3)); tmp.setIndex(new THREE.BufferAttribute(tris, 1));
      tmp.computeVertexNormals(); N.set((tmp.attributes.normal as THREE.BufferAttribute).array as Float32Array);
    }
    // imported models with inverted normals: flip so "outward" means outward
    const c = new THREE.Vector3();
    for (let i = 0; i < n; i++) c.x += P[i * 3], c.y += P[i * 3 + 1], c.z += P[i * 3 + 2];
    c.multiplyScalar(1 / Math.max(1, n));
    let dot = 0;
    for (let i = 0; i < n; i++) dot += (P[i * 3] - c.x) * N[i * 3] + (P[i * 3 + 1] - c.y) * N[i * 3 + 1] + (P[i * 3 + 2] - c.z) * N[i * 3 + 2];
    if (dot < 0) for (let i = 0; i < N.length; i++) N[i] = -N[i];
    for (let i = 0; i < n; i++) box.expandByPoint(v.fromArray(P, i * 3));
    body.push({ mesh, P, N, tris, off: nV, aw: anchoredWeights(mesh, anchorId) });
    nV += n; nT += tris.length / 3;
    yield;
  }
  const report: FitReport = {
    ms: 0, pushMs: 0, hideMs: 0, height: 0, margin: 0, costumeVertices: 0, verticesPushed: 0, verticesTucked: 0, maxPush: 0,
    meshesTouched: [], bodyTris: nT, hiddenTris: 0, groups: {},
  };
  const restorers: (() => void)[] = [];
  const done = (): CostumeFit => {
    report.ms = performance.now() - t0;
    console.info(`[costume fit] ${label}: pushed ${report.verticesPushed}/${report.costumeVertices} verts (max ${(report.maxPush * 1000).toFixed(1)} mm, ${report.verticesTucked} tucked under layers, ${report.pushMs.toFixed(0)} ms), hid ${report.hiddenTris}/${report.bodyTris} body tris (${report.hideMs.toFixed(0)} ms), total ${report.ms.toFixed(0)} ms`);
    return { report, restore: () => { for (const r of restorers) r(); restorers.length = 0; } };
  };
  if (!body.length || !costumeMeshes.length) return done();

  const H = Math.max(1e-3, box.max.y - box.min.y);
  report.height = H;
  const margin = Math.max(0, opts.margin ?? 0.006) * H;
  report.margin = margin;
  const maxDepth = 0.03 * H, fade = 0.015 * H, hi = margin * 1.5;

  // merged body geometry (world) for closest-point queries
  const bP = new Float32Array(nV * 3), bN = new Float32Array(nV * 3), bI = new Uint32Array(nT * 3);
  { let k = 0; for (const b of body) { bP.set(b.P, b.off * 3); bN.set(b.N, b.off * 3); for (let t = 0; t < b.tris.length; t++) bI[k++] = b.tris[t] + b.off; } }
  const bodyGeo = new THREE.BufferGeometry();
  bodyGeo.setAttribute('position', new THREE.BufferAttribute(bP, 3));
  bodyGeo.setIndex(new THREE.BufferAttribute(bI, 1));
  const bodyBVH = (yield { bvh: bodyGeo }) as MeshBVH;
  const bodyIndex = bodyGeo.index!.array as Uint32Array; // BVH-reordered, still valid triangles
  const bAW: Anchored = { ids: new Int32Array(nV * 4), w: new Float32Array(nV * 4) };
  for (const b of body) { bAW.ids.set(b.aw.ids, b.off * 4); bAW.w.set(b.aw.w, b.off * 4); }

  // closest body point among triangles skinned to the SAME body part as the costume vertex: torso
  // cloth passing through a hanging arm at rest is a pose overlap, not a fit error — never push it
  // out of the arm (it would bulge 5 cm and the arm moves away anyway).
  const cp = new THREE.Vector3(), best = { d: 0, tri: -1, point: new THREE.Vector3() };
  const compatible = (aw: Anchored, ci: number, ti: number) => {
    const f = ti * 3;
    return Math.max(similarity(aw, ci, bAW, bodyIndex[f]), similarity(aw, ci, bAW, bodyIndex[f + 1]), similarity(aw, ci, bAW, bodyIndex[f + 2])) >= 0.2;
  };
  const quick = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  const closestCompatible = (p: THREE.Vector3, aw: Anchored, ci: number, maxD: number) => {
    best.d = maxD; best.tri = -1;
    // fast path: the plain nearest triangle is usually on the right body part
    if (!bodyBVH.closestPointToPoint(p, quick, 0, maxD)) return false;
    if (compatible(aw, ci, quick.faceIndex)) { best.d = quick.distance; best.tri = quick.faceIndex; best.point.copy(quick.point); return true; }
    bodyBVH.shapecast({
      boundsTraverseOrder: (box) => box.distanceToPoint(p),
      intersectsBounds: (_box, _leaf, score) => (score !== undefined && score > best.d ? NOT_INTERSECTED : INTERSECTED),
      intersectsTriangle: (t, ti) => {
        t.closestPointToPoint(p, cp);
        const d = cp.distanceTo(p);
        if (d >= best.d || !compatible(aw, ci, ti)) return false;
        best.d = d; best.tri = ti; best.point.copy(cp);
        return false;
      },
    });
    return best.tri >= 0;
  };

  // ---- 1. push-out ----
  const tPush = performance.now();
  const costumeWorld = costumeMeshes.map(worldPositions);
  // costume-as-authored BVH: a vertex hidden under ANOTHER costume layer (a sleeve cap tucked into
  // the torso under the shirt, trouser tops under a coat) is deliberate construction — pushing it
  // out of the body would shove it through the layer above. Only uncovered vertices get pushed.
  const preBVH = margin > 0 ? (yield { bvh: mergedGeo(costumeMeshes, costumeWorld) }) as MeshBVH : null;
  const coverRay = new THREE.Ray();
  const layerAbove = (p: THREE.Vector3, n: THREE.Vector3) => {
    coverRay.origin.copy(p); coverRay.direction.copy(n);
    return !!preBVH!.raycastFirst(coverRay, THREE.DoubleSide, 1.5e-3 * H, maxDepth + 0.04 * H);
  };
  const q = H * 2e-5;
  const tri = new THREE.Triangle(), bc = new THREE.Vector3(), pv = new THREE.Vector3(), nv = new THREE.Vector3();
  for (const [mi, mesh] of costumeMeshes.entries()) {
    yield;
    const g = mesh.geometry;
    const pos = g.attributes.position as THREE.BufferAttribute;
    const W = costumeWorld[mi];
    report.costumeVertices += pos.count;
    if (margin <= 0) continue;
    const tris = triIndex(g);
    const caw = anchoredWeights(mesh, anchorId);
    const { id, count } = weld(W, q);
    // welded rep positions
    const rep = new Int32Array(count).fill(-1);
    for (let i = 0; i < id.length; i++) if (rep[id[i]] < 0) rep[id[i]] = i;
    // rigid components (one bone ≥ 98 % on every vertex) are props/hats/buckles: never warp them
    const parent = new Int32Array(count); for (let i = 0; i < count; i++) parent[i] = i;
    const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    for (let t = 0; t < tris.length; t += 3) {
      const a = find(id[tris[t]]), b = find(id[tris[t + 1]]), c = find(id[tris[t + 2]]);
      if (a !== b) parent[a] = b;
      const b2 = find(b); if (c !== b2) parent[c] = b2;
    }
    const si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    const compBone = new Map<number, number>(); // root → bone (-2 = not rigid)
    if (si && sw && (mesh as THREE.SkinnedMesh).isSkinnedMesh) {
      for (let i = 0; i < pos.count; i++) {
        const r = find(id[i]);
        let bk = 0; for (let k = 1; k < 4; k++) if (sw.getComponent(i, k) > sw.getComponent(i, bk)) bk = k;
        const bone = sw.getComponent(i, bk) >= 0.98 ? si.getComponent(i, bk) : -2;
        const prev = compBone.get(r);
        if (prev === undefined) compBone.set(r, bone); else if (prev !== bone) compBone.set(r, -2);
      }
    } else continue; // unskinned costume mesh = rigid attachment
    const rigid = (w: number) => (compBone.get(find(w)) ?? -2) >= 0;

    const D = new Float32Array(count * 3), Nd = new Float32Array(count * 3), req = new Float32Array(count);
    const active = new Uint8Array(count);
    let any = false;
    for (let w = 0; w < count; w++) {
      if ((w & 255) === 255) yield;
      if (rigid(w)) continue;
      active[w] = 1;
      const i = rep[w];
      pv.fromArray(W, i * 3);
      if (!closestCompatible(pv, caw, i, maxDepth + fade)) continue;
      const hit = best;
      const f = hit.tri * 3;
      const ia = bodyIndex[f], ib = bodyIndex[f + 1], ic = bodyIndex[f + 2];
      tri.a.fromArray(bP, ia * 3); tri.b.fromArray(bP, ib * 3); tri.c.fromArray(bP, ic * 3);
      tri.getBarycoord(hit.point, bc);
      nv.set(0, 0, 0)
        .addScaledVector(new THREE.Vector3().fromArray(bN, ia * 3), bc.x)
        .addScaledVector(new THREE.Vector3().fromArray(bN, ib * 3), bc.y)
        .addScaledVector(new THREE.Vector3().fromArray(bN, ic * 3), bc.z);
      if (nv.lengthSq() < 1e-12) tri.getNormal(nv); else nv.normalize();
      const d = pv.sub(hit.point).dot(nv);
      let delta = 0;
      if (d >= hi) delta = 0;
      else if (d >= -maxDepth) delta = margin + ((d + maxDepth) / (hi + maxDepth)) * (hi - margin) - d;
      else if (d >= -maxDepth - fade) delta = (margin - (-maxDepth)) * ((d + maxDepth + fade) / fade);
      Nd[w * 3] = nv.x; Nd[w * 3 + 1] = nv.y; Nd[w * 3 + 2] = nv.z;
      if (delta > 1e-7 && layerAbove(pv.fromArray(W, i * 3), nv)) { report.verticesTucked++; delta = 0; }
      if (delta > 1e-7) {
        req[w] = delta; any = true;
        D[w * 3] = nv.x * delta; D[w * 3 + 1] = nv.y * delta; D[w * 3 + 2] = nv.z * delta;
      }
    }
    if (!any) continue;
    // smooth the displacement field (not the positions), re-enforcing each pushed minimum
    const { start, nb } = adjacency(tris, id, count);
    let cur = D, nxt = new Float32Array(count * 3);
    for (let pass = 0; pass < 3; pass++) {
      for (let w = 0; w < count; w++) {
        if (!active[w]) continue;
        let x = cur[w * 3], y = cur[w * 3 + 1], z = cur[w * 3 + 2], c = 1;
        for (let k = start[w]; k < start[w + 1]; k++) { const j = nb[k]; if (!active[j]) continue; x += cur[j * 3]; y += cur[j * 3 + 1]; z += cur[j * 3 + 2]; c++; }
        x /= c; y /= c; z /= c;
        if (req[w] > 0) {
          const along = x * Nd[w * 3] + y * Nd[w * 3 + 1] + z * Nd[w * 3 + 2];
          if (along < req[w]) { const e = req[w] - along; x += Nd[w * 3] * e; y += Nd[w * 3 + 1] * e; z += Nd[w * 3 + 2] * e; }
        }
        nxt[w * 3] = x; nxt[w * 3 + 1] = y; nxt[w * 3 + 2] = z;
      }
      [cur, nxt] = [nxt, cur];
      yield;
    }
    // write back into bind space
    const Rl = new THREE.Matrix3().setFromMatrix4(restMatrix(mesh)).invert();
    const before = vertexNormals(pos.array as Float32Array, g.index);
    const arr = pos.array as Float32Array;
    const dl = new THREE.Vector3();
    const moved = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const w = id[i];
      const L = Math.hypot(cur[w * 3], cur[w * 3 + 1], cur[w * 3 + 2]);
      if (L < 1e-7) continue;
      dl.set(cur[w * 3], cur[w * 3 + 1], cur[w * 3 + 2]);
      W[i * 3] += dl.x; W[i * 3 + 1] += dl.y; W[i * 3 + 2] += dl.z;
      dl.applyMatrix3(Rl);
      moved[i * 3] = dl.x; moved[i * 3 + 1] = dl.y; moved[i * 3 + 2] = dl.z;
      arr[i * 3] += dl.x; arr[i * 3 + 1] += dl.y; arr[i * 3 + 2] += dl.z;
    }
    for (let w = 0; w < count; w++) if (req[w] > 1e-4 * H) { report.verticesPushed++; report.maxPush = Math.max(report.maxPush, req[w]); }
    pos.needsUpdate = true;
    // normals: original + (recomputed after − recomputed before) keeps hard edges / UV seams intact
    const nrm = g.attributes.normal as THREE.BufferAttribute | undefined;
    if (nrm) {
      const after = vertexNormals(arr, g.index);
      const na = nrm.array as Float32Array;
      for (let i = 0; i < pos.count; i++) {
        if (moved[i * 3] === 0 && moved[i * 3 + 1] === 0 && moved[i * 3 + 2] === 0) continue;
        const x = na[i * 3] + after[i * 3] - before[i * 3], y = na[i * 3 + 1] + after[i * 3 + 1] - before[i * 3 + 1], z = na[i * 3 + 2] + after[i * 3 + 2] - before[i * 3 + 2];
        const l = Math.hypot(x, y, z) || 1;
        na[i * 3] = x / l; na[i * 3 + 1] = y / l; na[i * 3 + 2] = z / l;
      }
      nrm.needsUpdate = true;
    }
    // absolute morph targets ride along (relative ones are deltas: unchanged)
    if (g.morphAttributes.position?.length && !g.morphTargetsRelative) {
      for (const mt of g.morphAttributes.position) {
        const ma = mt.array as Float32Array;
        for (let i = 0; i < Math.min(ma.length, moved.length); i++) ma[i] += moved[i];
        mt.needsUpdate = true;
      }
    }
    g.computeBoundingSphere(); g.computeBoundingBox();
    report.meshesTouched.push(mesh.name);
  }
  preBVH?.geometry.dispose();
  report.pushMs = performance.now() - tPush;

  // ---- 2. hide covered body ----
  if (opts.hideBody !== false) {
    const tHide = performance.now();
    const cBVH = (yield { bvh: mergedGeo(costumeMeshes, costumeWorld) }) as MeshBVH;
    const cV = costumeWorld.reduce((a, W) => a + W.length / 3, 0);
    const cAW: Anchored = { ids: new Int32Array(cV * 4), w: new Float32Array(cV * 4) };
    { let vo = 0;
      costumeMeshes.forEach((m, mi) => {
        const aw = anchoredWeights(m, anchorId); cAW.ids.set(aw.ids, vo * 4); cAW.w.set(aw.w, vo * 4);
        vo += costumeWorld[mi].length / 3;
      }); }
    const maxDist = 0.04 * H, eps = 1e-4 * H;
    const keep = opts.keepVisible ?? [];
    const hideIn = [...(opts.hideInside ?? []), ...bindSpheres(bodies, opts.hideInsideBind ?? [])];
    const ray = new THREE.Ray();
    const dirs = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const t1 = new THREE.Vector3(), t2 = new THREE.Vector3(), o = new THREE.Vector3();
    const cos = Math.cos(THREE.MathUtils.degToRad(25)), sin = Math.sin(THREE.MathUtils.degToRad(25));
    const covered = (p: THREE.Vector3, n: THREE.Vector3, aw: Anchored, vi: number) => {
      t1.set(Math.abs(n.x) < 0.9 ? 1 : 0, Math.abs(n.x) < 0.9 ? 0 : 1, 0).cross(n).normalize();
      t2.crossVectors(n, t1);
      dirs[0].copy(n);
      for (let k = 0; k < 3; k++) {
        const a = (k * 2 * Math.PI) / 3;
        dirs[k + 1].copy(n).multiplyScalar(cos).addScaledVector(t1, sin * Math.cos(a)).addScaledVector(t2, sin * Math.sin(a));
      }
      o.copy(p).addScaledVector(n, eps);
      for (const d of dirs) {
        ray.set(o, d);
        const h = cBVH.raycastFirst(ray, THREE.DoubleSide, 0, maxDist);
        if (!h || !h.face) return false;
        const s = (similarity(aw, vi, cAW, h.face.a) + similarity(aw, vi, cAW, h.face.b) + similarity(aw, vi, cAW, h.face.c)) / 3;
        if (s < 0.35) return false;
      }
      return true;
    };
    const p = new THREE.Vector3(), n = new THREE.Vector3();
    for (const b of body) {
      yield;
      const g = b.mesh.geometry;
      const nv0 = b.P.length / 3;
      const { id, count } = weld(b.P, q);
      const nsum = new Float32Array(count * 3), rep = new Int32Array(count).fill(-1);
      for (let i = 0; i < nv0; i++) {
        const w = id[i]; if (rep[w] < 0) rep[w] = i;
        nsum[w * 3] += b.N[i * 3]; nsum[w * 3 + 1] += b.N[i * 3 + 1]; nsum[w * 3 + 2] += b.N[i * 3 + 2];
      }
      const cov = new Uint8Array(count);
      // hand / foot groups: all-or-nothing (a sleeve over the wrist must not eat half a hand)
      const groupOf = new Int32Array(count).fill(-1);
      const gTot = new Map<number, number>(), gCov = new Map<number, number>();
      for (let w = 0; w < count; w++) {
        if ((w & 127) === 127) yield;
        const i = rep[w];
        p.fromArray(b.P, i * 3);
        if (keep.some((s) => p.distanceToSquared(s.center) < s.radius * s.radius)) continue;
        if (hideIn.length && hideIn.some((s) => p.distanceToSquared(s.center) < s.radius * s.radius)) { cov[w] = 1; continue; }
        n.fromArray(nsum, w * 3);
        if (n.lengthSq() < 1e-12) continue;
        n.normalize();
        // dominant anchor → hand/foot group?
        let bk = 0; for (let k = 1; k < 4; k++) if (b.aw.w[i * 4 + k] > b.aw.w[i * 4 + bk]) bk = k;
        const aid = b.aw.ids[i * 4 + bk];
        const role = aid >= 0 ? anchorRole[aid] : '';
        const hm = HANDFOOT.exec(role);
        const grp = hm ? (hm[1] === 'left' ? 0 : 2) + (/Foot|Toes/.test(hm[2]) ? 1 : 0) : -1;
        groupOf[w] = grp;
        if (grp >= 0) gTot.set(grp, (gTot.get(grp) ?? 0) + 1);
        if (covered(p, n, b.aw, i)) { cov[w] = 1; if (grp >= 0) gCov.set(grp, (gCov.get(grp) ?? 0) + 1); }
      }
      for (const [grp, tot] of gTot) {
        const cv = gCov.get(grp) ?? 0, ok = cv >= tot * 0.95;
        report.groups[`${b.mesh.name}:${['leftHand', 'leftFoot', 'rightHand', 'rightFoot'][grp]}`] = { covered: cv, total: tot, hidden: ok };
        if (!ok) for (let w = 0; w < count; w++) if (groupOf[w] === grp) cov[w] = 0;
      }
      // triangles with 3 covered corners go; keep draw groups (multi-material) consistent
      const src = b.tris;
      const hideTri = (t: number) => cov[id[src[t * 3]]] && cov[id[src[t * 3 + 1]]] && cov[id[src[t * 3 + 2]]];
      let hidden = 0;
      for (let t = 0; t < src.length / 3; t++) if (hideTri(t)) hidden++;
      if (!hidden) continue;
      const fullIndex = g.index;
      const fullGroups = g.groups.map((gr) => ({ ...gr }));
      const red = dropTriangles(src, hideTri, fullGroups);
      g.setIndex(new THREE.BufferAttribute(red.index, 1));
      if (fullGroups.length) { g.clearGroups(); for (const gr of red.groups) g.addGroup(gr.start, gr.count, gr.materialIndex); }
      g.userData.vtpFullIndex = fullIndex;
      report.hiddenTris += hidden;
      restorers.push(() => {
        g.setIndex(fullIndex);
        if (fullGroups.length) { g.clearGroups(); for (const gr of fullGroups) g.addGroup(gr.start, gr.count, gr.materialIndex); }
        delete g.userData.vtpFullIndex;
      });
    }
    cBVH.geometry.dispose();
    report.hideMs = performance.now() - tHide;
  }
  bodyGeo.dispose();
  return done();
}

/**
 * Pure: a triangle index without the triangles `hideTri` drops, and its draw groups. The index is built ONCE, in the
 * original triangle order; each group keeps exactly its own triangles that stay. Groups may overlap: three-vrm's MToon
 * outline is a second FULL-RANGE group over the same triangles (addGroup(0, n, 0) + addGroup(0, n, 1)), and both
 * become (0, k). The old hide pass wrote every group's triangles one after another into an index with room for one
 * copy, so the outline group started where the index ended and drew nothing (review of beta.9).
 */
export function dropTriangles(src: ArrayLike<number>, hideTri: (t: number) => unknown,
  groups: readonly { start: number; count: number; materialIndex?: number }[]) {
  const nT = Math.floor(src.length / 3);
  const before = new Uint32Array(nT + 1);                              // triangles kept before triangle t
  const drop = new Uint8Array(nT);
  let k = 0;
  for (let t = 0; t < nT; t++) { before[t] = k; if (hideTri(t)) drop[t] = 1; else k++; }
  before[nT] = k;
  const index = new Uint32Array(k * 3);
  for (let t = 0, j = 0; t < nT; t++) if (!drop[t]) { index[j++] = src[t * 3]; index[j++] = src[t * 3 + 1]; index[j++] = src[t * 3 + 2]; }
  const at = (t: number) => before[Math.min(nT, Math.max(0, t))] * 3;
  const out = groups.map((gr) => {
    const t0 = Math.floor(gr.start / 3);
    const t1 = Number.isFinite(gr.count) ? Math.ceil(Math.min(src.length, gr.start + gr.count) / 3) : nT;
    const s = at(t0);
    return { start: s, count: Math.max(0, at(t1) - s), materialIndex: gr.materialIndex };
  });
  return { index, groups: out };
}

/** Bind-space spheres -> render-frame world, through the first body skin that carries the bone (rest pose). */
function bindSpheres(bodies: THREE.Mesh[], list: { center: THREE.Vector3; radius: number; bone: string }[]): FitSphere[] {
  const out: FitSphere[] = [];
  for (const s of list) {
    for (const m of bodies) {
      const sm = m as THREE.SkinnedMesh;
      if (!sm.isSkinnedMesh || !sm.skeleton) continue;
      const bi = sm.skeleton.bones.findIndex((b) => b.name === s.bone);
      if (bi < 0) continue;
      const B = new THREE.Matrix4().multiplyMatrices(sm.skeleton.bones[bi].matrixWorld, sm.skeleton.boneInverses[bi]);
      const M = sm.matrixWorld.clone().multiply(sm.bindMatrixInverse).multiply(B).multiply(sm.bindMatrix);
      out.push({ center: s.center.clone().applyMatrix4(M), radius: s.radius });
      break;
    }
  }
  return out;
}

/** One geometry over several meshes' world positions (vertex ids = concatenation order), for one BVH. */
function mergedGeo(meshes: THREE.Mesh[], world: Float32Array[]): THREE.BufferGeometry {
  const nV = world.reduce((a, W) => a + W.length / 3, 0);
  const idx = meshes.map((m) => triIndex(m.geometry));
  const P = new Float32Array(nV * 3), I = new Uint32Array(idx.reduce((a, t) => a + t.length, 0));
  let vo = 0, k = 0;
  meshes.forEach((_, mi) => { P.set(world[mi], vo * 3); for (const t of idx[mi]) I[k++] = t + vo; vo += world[mi].length / 3; });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setIndex(new THREE.BufferAttribute(I, 1));
  return g;
}

/** Area-weighted vertex normals of (positions, index) — no welding, so seams stay split. */
function vertexNormals(P: Float32Array, index: THREE.BufferAttribute | null): Float32Array {
  const tmp = new THREE.BufferGeometry();
  tmp.setAttribute('position', new THREE.BufferAttribute(P.slice(), 3));
  if (index) tmp.setIndex(index);
  tmp.computeVertexNormals();
  return (tmp.attributes.normal as THREE.BufferAttribute).array as Float32Array;
}
