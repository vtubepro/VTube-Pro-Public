// Avatar detail: find the geometries of a BUILT avatar that may get lighter levels and their twins, and gather what
// the per-triangle classes need (shared/lod/classify.ts: the moved mask, dominant-bone regions, the protection-sphere
// mask), on the main thread in slices of at most ~4 ms (setTimeout 0 between slices) so a live OBS page never stalls.
// The classification itself and the simplification run in the lod worker (src/avatar/lod/lodWorker.ts). Works on the
// final three.js geometry: it sees the costume-fit hides and the runtime vtp_ mouth shape keys.
//
// Eligible: an indexed triangle mesh (collectMeshes with costumes) with the full drawRange; no groups, or only groups
// that start at 0 and cover the whole index (three-vrm's MToon outline duplicates); no blended (transparent) material;
// not an outline / shell itself; (in the worker) >= DETAIL_MIN_FREE_TRIS triangles left after the face class.
// A geometry can be drawn by SEVERAL meshes (GLTFLoader shares one geometry between the nodes that use the same glTF
// mesh, e.g. a mirrored pair of shoes or gloves): every one of them counts. Any of them with a blended material = not
// eligible; every one's toon outline is a twin; the most protective head / hair region and the largest world scale (the
// smallest local error) win.
// Twins (switch with it, sharing the same level buffers): the toon outline clones (userData.vtpOutlineOf, same vertex
// count), fur shells (they share the index object: surfaceStyles makeShell), MToon outline groups (same geometry).
// Any OTHER geometry holding the candidate's index = an unknown sharer: the candidate stays at Full.
// Face bones (DetailSource.detailFaceBones: the jaw rig's jaw / upper head, the humanoid jaw and eyes, and every bone
// under them) move parts of the face without any shape key: every vertex they weigh joins the moved mask, i.e. the face.
import * as THREE from 'three';
import { DETAIL_REF_MM } from '../../../shared/avatarDetail.ts';
import { REGION_BODY, REGION_HAIR, REGION_HEAD, markMoved, nameFlags, type NameFlags } from '../../../shared/lod/classify.ts';
import { collectMeshes } from '../surfacePatch.ts';

export interface DetailSphere { center: THREE.Vector3; radius: number }

/** What extraction needs from the runtime (structural: no import of AvatarRuntime). */
export interface DetailSource {
  model: THREE.Object3D;
  wrapper: THREE.Object3D;
  humanoid: { getRawBoneNode(name: 'head'): THREE.Object3D | null } | null;
  /** World-space protection spheres at rest: the face sphere + the procedural mouth / eye keep spheres. */
  detailSpheres(): DetailSphere[];
  /** Bones that move part of the face by themselves (bone-driven mouths, eyes); their subtrees count too. */
  detailFaceBones?(): THREE.Object3D[];
}

/** Skin weights at or under this are ignored (quantised weights leave crumbs). */
const FACE_BONE_EPS = 1e-3;

/** What the lod worker gets for one geometry (all buffers are copies: transferred). */
export interface RawJob {
  vcount: number;
  pos: Float32Array;
  nrm: Float32Array | null;
  /** The L0 triangle list (Uint32 copy). */
  index: Uint32Array;
  moved: Uint8Array;
  sphere: Uint8Array;
  region: Uint8Array | null;
  flags: NameFlags;
  /** Mesh-local units per mm of a 1.7 m-normalised avatar. */
  unit: number;
}

export interface DetailEntry {
  /** The candidate mesh (the first mesh found using the geometry). */
  mesh: THREE.Mesh;
  name: string;
  geometry: THREE.BufferGeometry;
  /** Geometries that switch together with it (outline clones, fur shells). */
  twins: THREE.BufferGeometry[];
  /** Each geometry's own original (L0) index. */
  l0: Map<THREE.BufferGeometry, THREE.BufferAttribute>;
  /** Until it is posted to the worker (then null: its buffers were transferred). */
  raw: RawJob | null;
  tris: number;
}

/** The avatar at attach time (right after the build, before the page places it anywhere): the world matrices, the rest
 *  height and the protection spheres the extraction uses, whenever it runs. The same model gives the same levels on every
 *  page, wherever its stand-in was placed by the time the levels are prepared. */
export interface DetailSnapshot { restHeight: number; wrapperScale: number; spheres: DetailSphere[]; matrices: Map<THREE.Object3D, THREE.Matrix4> }

export function detailSnapshot(src: DetailSource): DetailSnapshot {
  src.wrapper.updateWorldMatrix(true, true);
  const restHeight = new THREE.Box3().setFromObject(src.model).getSize(new THREE.Vector3()).y || 1.7;
  const matrices = new Map<THREE.Object3D, THREE.Matrix4>();
  src.wrapper.traverse((o) => { if ((o as THREE.Mesh).isMesh) matrices.set(o, o.matrixWorld.clone()); });
  return { restHeight, wrapperScale: src.wrapper.matrixWorld.getMaxScaleOnAxis() || 1, spheres: src.detailSpheres(), matrices };
}

export interface Extracted { entries: DetailEntry[]; skipped: { name: string; why: string; tris: number }[]; restHeight: number; ms: number; slices: number; longestSlice: number; longestAt: string }

/** Cooperative time slicing: call `await s.check()` often; it yields (setTimeout 0) once `budget` ms have passed. */
export class Slicer {
  private t0 = performance.now();
  slices = 1;
  longest = 0;
  /** Where the longest slice ended (diagnostics). */
  longestAt = '';
  constructor(private budget = 4, private alive: () => boolean = () => true) {}
  get over() { return performance.now() - this.t0 > this.budget; }
  async check(at = '') {
    if (!this.over) return;
    await this.yieldNow(at);
  }
  async yieldNow(at = '') {
    const d = performance.now() - this.t0;
    if (d > this.longest) { this.longest = d; this.longestAt = at; }
    await new Promise<void>((r) => setTimeout(r, 0));
    this.slices++;
    this.t0 = performance.now();
    if (!this.alive()) throw new DetailCancelled();
  }
  end(at = 'end') { const d = performance.now() - this.t0; if (d > this.longest) { this.longest = d; this.longestAt = at; } }
}
export class DetailCancelled extends Error { constructor() { super('avatar detail: cancelled'); } }

const mats = (m: THREE.Mesh) => (Array.isArray(m.material) ? m.material : [m.material]).filter(Boolean) as THREE.Material[];
const isShell = (m: THREE.Object3D) => !!m.userData?.vtpShell || mats(m as THREE.Mesh).some((x) => x.userData?.vtpShell);

/** Copy an attribute's x/y/z into a fresh Float32Array (any storage: interleaved, normalised, int). */
async function xyz(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, s: Slicer): Promise<Float32Array> {
  const n = a.count, out = new Float32Array(n * 3);
  const plain = (a as THREE.BufferAttribute).isBufferAttribute && a.itemSize === 3 && !a.normalized && a.array instanceof Float32Array;
  if (plain) {
    const src = a.array as Float32Array;
    for (let i = 0; i < n * 3; i += 262144) { out.set(src.subarray(i, Math.min(n * 3, i + 262144)), i); await s.check('copy'); }
    return out;
  }
  for (let i = 0; i < n; i++) {
    out[i * 3] = a.getX(i); out[i * 3 + 1] = a.getY(i); out[i * 3 + 2] = a.getZ(i);
    if ((i & 2047) === 0) await s.check('copy-any');
  }
  return out;
}

/** Morph deltas -> moved mask, sliced. */
async function movedMask(g: THREE.BufferGeometry, pos: Float32Array, s: Slicer): Promise<Uint8Array> {
  const n = pos.length / 3, moved = new Uint8Array(n);
  const rel = g.morphTargetsRelative;
  for (const key of ['position', 'normal'] as const) {
    const list = g.morphAttributes[key] ?? [];
    const base = rel ? null : key === 'position' ? pos : g.attributes.normal ? await xyz(g.attributes.normal as THREE.BufferAttribute, s) : null;
    for (const t of list) {
      const plain = (t as THREE.BufferAttribute).isBufferAttribute && !t.normalized && t.array instanceof Float32Array;
      const arr = plain ? (t.array as Float32Array) : await xyz(t, s);
      const step = plain ? t.itemSize : 3;
      for (let i = 0; i < n; i += 4096) {
        markMoved(moved, arr, step, base, i, Math.min(n, i + 4096));
        await s.check('moved');
      }
    }
  }
  return moved;
}

/** How protective a region is when two meshes drawing the same geometry disagree (head / hair: half the body's error). */
const PROTECT: Record<number, number> = { [REGION_BODY]: 0, [REGION_HAIR]: 1, [REGION_HEAD]: 2 };

/** Per vertex, over EVERY mesh that draws the geometry: the dominant-bone region (head subtree minus hair = head, hair
 *  bones = hair; the most protective one when the meshes disagree) and whether any face bone weighs it (`faceBone`). */
async function skinScan(meshes: THREE.Mesh[], head: THREE.Object3D | null, faceBones: Set<THREE.Object3D>, modelRoot: THREE.Object3D, s: Slicer): Promise<{ region: Uint8Array; faceBone: Uint8Array | null }> {
  const memo = new Map<THREE.Object3D, number>();
  const regionOf = (o: THREE.Object3D | null): number => {
    if (!o) return REGION_BODY;
    let r = memo.get(o);
    if (r !== undefined) return r;
    r = REGION_BODY;
    let underHead = false, hair = false;
    for (let p: THREE.Object3D | null = o; p && p !== modelRoot; p = p.parent) {
      if (nameFlags(p.name).hair) hair = true;
      if (p === head) { underHead = true; break; }
    }
    r = hair ? REGION_HAIR : underHead ? REGION_HEAD : REGION_BODY;
    memo.set(o, r);
    return r;
  };
  const g = meshes[0].geometry;
  const n = g.attributes.position.count;
  const region = new Uint8Array(n);
  let faceBone: Uint8Array | null = null;
  const SI = g.attributes.skinIndex, SW = g.attributes.skinWeight;
  let first = true;
  const merge = (i: number, r: number) => { if (first || PROTECT[r] > PROTECT[region[i]]) region[i] = r; };
  for (const mesh of meshes) {
    const sm = mesh as THREE.SkinnedMesh;
    if (sm.isSkinnedMesh && sm.skeleton && SI && SW) {
      const bones = sm.skeleton.bones;
      const boneReg = bones.map((b) => regionOf(b));
      const boneFace = bones.map((b) => faceBones.has(b));
      const anyFace = boneFace.some(Boolean);
      if (anyFace) faceBone ??= new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        let best = 0, bw = -1;
        for (let k = 0; k < 4; k++) {
          const w = SW.getComponent(i, k), b = SI.getComponent(i, k);
          if (w > bw) { bw = w; best = b; }
          if (anyFace && w > FACE_BONE_EPS && boneFace[b]) faceBone![i] = 1;
        }
        merge(i, boneReg[best] ?? REGION_BODY);
        if ((i & 2047) === 0) await s.check('regions');
      }
    } else {
      const r = regionOf(mesh);
      for (let i = 0; i < n; i++) merge(i, r);
      // a rigid mesh hanging under a face bone (a jaw piece, an eyeball) moves with it
      for (let p: THREE.Object3D | null = mesh; p && p !== modelRoot; p = p.parent) if (faceBones.has(p)) { (faceBone ??= new Uint8Array(n)).fill(1); break; }
    }
    first = false;
  }
  return { region, faceBone };
}

/** The face bones and every bone / object under them. */
function faceBoneSet(src: DetailSource): Set<THREE.Object3D> {
  const out = new Set<THREE.Object3D>();
  for (const b of src.detailFaceBones?.() ?? []) b.traverse((o) => { out.add(o); });
  return out;
}

/** Vertices inside any protection sphere (bind-space position x mesh.matrixWorld, at attach time). */
async function sphereMask(meshes: THREE.Mesh[], pos: Float32Array, spheres: DetailSphere[], snap: DetailSnapshot, s: Slicer): Promise<Uint8Array> {
  const n = pos.length / 3, out = new Uint8Array(n);
  if (!spheres.length) return out;
  const v = new THREE.Vector3();
  const r2 = spheres.map((sp) => sp.radius * sp.radius);
  for (const m of meshes) {
    const M = snap.matrices.get(m) ?? m.matrixWorld;
    for (let i = 0; i < n; i++) {
      if ((i & 4095) === 0) await s.check('sphere');
      if (out[i]) continue;
      v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).applyMatrix4(M);
      for (let k = 0; k < spheres.length; k++) if (v.distanceToSquared(spheres[k].center) < r2[k]) { out[i] = 1; break; }
    }
  }
  return out;
}

/** A Uint32 copy of an index, sliced. */
async function indexCopy(a: THREE.BufferAttribute, s: Slicer): Promise<Uint32Array> {
  const n = a.count, src = a.array as ArrayLike<number> & { subarray?: (a: number, b: number) => ArrayLike<number> };
  const out = new Uint32Array(n);
  if (src instanceof Uint32Array) { for (let i = 0; i < n; i += 262144) { out.set(src.subarray(i, Math.min(n, i + 262144)), i); await s.check('index'); } return out; }
  for (let i = 0; i < n; i += 65536) { const e = Math.min(n, i + 65536); for (let k = i; k < e; k++) out[k] = src[k]; await s.check('index'); }
  return out;
}

/** Find every eligible geometry of the avatar + gather its worker job. Throws DetailCancelled when `alive()` turns false. */
export async function extractDetail(src: DetailSource, snap: DetailSnapshot, opts: { alive: () => boolean; sliceMs?: number }): Promise<Extracted> {
  const t0 = performance.now();
  const s = new Slicer(opts.sliceMs ?? 4, opts.alive);
  await s.yieldNow('start');   // never inside the caller's task (the avatar load)
  const { restHeight, spheres } = snap;
  const head = src.humanoid?.getRawBoneNode('head') ?? null;
  // every mesh of the avatar (outlines, shells, patches included): who holds which index / geometry
  const all: THREE.Mesh[] = [];
  src.wrapper.traverse((o) => { if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry) all.push(o as THREE.Mesh); });
  const holders = new Map<THREE.BufferAttribute, Set<THREE.BufferGeometry>>();
  const users = new Map<THREE.BufferGeometry, THREE.Mesh[]>();
  for (const m of all) {
    const g = m.geometry;
    (users.get(g) ?? users.set(g, []).get(g)!).push(m);
    if (g.index) (holders.get(g.index) ?? holders.set(g.index, new Set()).get(g.index)!).add(g);
  }
  const outlinesOf = new Map<THREE.Mesh, THREE.Mesh[]>();
  for (const m of all) { const of = m.userData?.vtpOutlineOf as THREE.Mesh | undefined; if (of) (outlinesOf.get(of) ?? outlinesOf.set(of, []).get(of)!).push(m); }
  const faceBones = faceBoneSet(src);
  const entries: DetailEntry[] = [];
  const skipped: Extracted['skipped'] = [];
  const seen = new Set<THREE.BufferGeometry>();
  for (const mesh of collectMeshes(src.model, { costumes: true })) {
    const g = mesh.geometry as THREE.BufferGeometry;
    if (seen.has(g)) continue;
    seen.add(g);
    // every mesh that draws this geometry (not its outline / shell hulls): GLTFLoader shares a geometry between the nodes
    // of one glTF mesh (a mirrored pair of shoes / gloves), and they all switch together
    const drawers = (users.get(g) ?? [mesh]).filter((m) => !m.userData.vtpOutline && !m.userData.vtpOutlineOf && !isShell(m));
    if (!drawers.includes(mesh)) drawers.unshift(mesh);
    const name = `${mesh.name} ${mats(mesh).map((x) => x.name).join(' ')}`.trim();
    const idx = g.index;
    const tris = idx ? Math.floor(idx.count / 3) : Math.floor(g.attributes.position.count / 3);
    const skip = (why: string) => { skipped.push({ name, why, tris }); };
    if (!idx) { skip('not indexed'); continue; }
    if ((g as THREE.InstancedBufferGeometry).isInstancedBufferGeometry || drawers.some((m) => (m as THREE.InstancedMesh).isInstancedMesh)) { skip('instanced'); continue; }
    if (mesh.userData.vtpOutline || isShell(mesh) || mesh.userData.vtpOutlineOf) { skip('outline / shell'); continue; }
    if (g.drawRange.start !== 0 || g.drawRange.count < idx.count) { skip('partial draw range'); continue; }
    if (g.groups.some((gr) => gr.start !== 0 || gr.count < idx.count)) { skip('material groups'); continue; }
    if (drawers.some((m) => mats(m).some((x) => x.transparent))) { skip('blended material'); continue; }
    if (idx.count % 3) { skip('not a triangle list'); continue; }
    // twins + unknown sharers of the index
    const twins: THREE.BufferGeometry[] = [];
    let foreign = false;
    for (const h of holders.get(idx) ?? []) {
      if (h === g) continue;
      const hm = users.get(h) ?? [];
      if (hm.length && hm.every(isShell)) twins.push(h); else foreign = true;
    }
    // the toon outline of EVERY drawer (makeOutline gives each mesh its own clone)
    for (const o of drawers.flatMap((d) => outlinesOf.get(d) ?? [])) {
      const og = o.geometry;
      if (og === g || twins.includes(og)) continue;
      if (og.attributes.position.count !== g.attributes.position.count || !og.index || og.index.count !== idx.count) { foreign = true; continue; }
      // the outline's own index must not be shared with anything else either
      if ([...(holders.get(og.index) ?? [])].some((h) => h !== og && !(users.get(h) ?? []).every(isShell))) { foreign = true; continue; }
      twins.push(og);
      for (const h of holders.get(og.index) ?? []) if (h !== og && !twins.includes(h)) twins.push(h);
    }
    if (foreign) { skip('index shared with another geometry'); continue; }
    // per-vertex data, sliced
    await s.check('mesh');
    const pos = await xyz(g.attributes.position as THREE.BufferAttribute, s);
    const moved = await movedMask(g, pos, s);
    const { region, faceBone } = await skinScan(drawers, head, faceBones, src.model, s);
    if (faceBone) for (let i = 0; i < moved.length; i++) if (faceBone[i]) moved[i] = 1;   // bone-driven face parts = face
    const sphere = await sphereMask(users.get(g)!.filter((m) => !m.userData.vtpOutline), pos, spheres, snap, s);
    const index = await indexCopy(idx, s);
    const nrm = g.attributes.normal ? await xyz(g.attributes.normal as THREE.BufferAttribute, s) : null;
    // the largest world scale of the drawers: the smallest error in mesh-local units (nobody gets more than their mm)
    const scale = Math.max(...drawers.map((m) => (snap.matrices.get(m) ?? m.matrixWorld).getMaxScaleOnAxis() || 1));
    const l0 = new Map<THREE.BufferGeometry, THREE.BufferAttribute>([[g, idx]]);
    for (const t of twins) l0.set(t, t.index!);
    entries.push({
      mesh, name, geometry: g, twins, l0, tris,
      raw: { vcount: pos.length / 3, pos, nrm, index, moved, sphere, region, flags: nameFlags(name), unit: restHeight / DETAIL_REF_MM / scale },
    });
    await s.check('entry');
  }
  s.end();
  return { entries, skipped, restHeight, ms: performance.now() - t0, slices: s.slices, longestSlice: s.longest, longestAt: s.longestAt };
}

