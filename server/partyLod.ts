// Automatic "party version" of an avatar (docs/MULTIPLAYER_DISCORD.md → "Party version"): when a performer's model
// (+ worn costume) is over the party's polycount limit (default 200,000 triangles, shared/modelStats.ts), parties share a
// region-weighted, reduced copy instead of refusing the avatar.
//
// How: INDEX-ONLY simplification with meshoptimizer (MIT; ships with the three.js types). Every vertex stays exactly
// as authored, only the triangle lists are rebuilt, so shape keys (ARKit / visemes / VRM expressions), skin weights,
// UV seams, materials and every glTF / VRM extension survive byte-identical. (Blender is not used on purpose: its
// glTF exporter drops the VRM extensions — humanoid, expressions, spring bones, MToon — and its Decimate modifier
// can't be applied to meshes with shape keys.)
//   * regions per triangle (from the skin): FACE = the head bone's own vertices + every vertex a shape key moves;
//     HAIR = hair bones / hair-named meshes; BODY = the rest (clothes, limbs, hidden body). The triangle budget is
//     split with weights face 6 : hair 2.2 : body 1 (bisection), so the body and clothing give up triangles first;
//   * locked (never collapsed): vertices shape keys move in face regions (expressions keep their full density),
//     vertices shared with another primitive / region (no cracks between materials, meshes or regions); attribute
//     seams (UV / normal splits) are kept by the simplifier itself; primitives under 400 triangles (eyes, teeth,
//     lids) are kept whole;
//   * a normals attribute keeps shading edges; silhouettes (hair) follow from the geometric error metric.
// The result is checked before it is used: triangle count ≤ target, glTF custody checks (partyWire glbProblem), and
// the same meshes / primitives / shape keys / skins / images / extensions as the source.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { clampTrisLimit, gltfStats, type PartyLodStatus } from '../shared/modelStats.ts';
import { glbProblem } from '../shared/partyWire.ts';
import { fileStats, requireProfile, resolveAvatarFile, userDir } from './library.ts';
import { runOffLoop } from './spawnOffLoop.ts';

export const LOD_VERSION = 2;
const fmtCount = (n: number) => Math.round(n).toLocaleString('en-US');
// face = shape-key-moved / face-named vertices; head = the rest of the head bone (skull, hat); hair; body (clothes, limbs)
const UVW = Number(process.env.VTP_LOD_UVW ?? 12);
const WEIGHT = { face: 6, head: 2.5, hair: 2, body: 1 } as const;
const TINY = 400;
type Region = keyof typeof WEIGHT;

export interface Glb { json: Record<string, any>; bin: Uint8Array }

export function readGlb(b: Uint8Array): Glb {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.byteLength < 28 || dv.getUint32(0, true) !== 0x46546c67 || dv.getUint32(4, true) !== 2) throw new Error('not a glTF 2.0 binary (GLB / VRM)');
  const jl = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== 0x4e4f534a) throw new Error('bad GLB JSON chunk');
  const json = JSON.parse(new TextDecoder().decode(b.subarray(20, 20 + jl)));
  let bin: Uint8Array = new Uint8Array(0);
  const off = 20 + jl;
  if (off + 8 <= b.byteLength && dv.getUint32(off + 4, true) === 0x004e4942) bin = b.subarray(off + 8, off + 8 + dv.getUint32(off, true));
  return { json, bin };
}

export function writeGlb(json: Record<string, unknown>, bin: Uint8Array): Uint8Array {
  let js = new TextEncoder().encode(JSON.stringify(json));
  const jpad = (4 - (js.length % 4)) % 4, bpad = (4 - (bin.length % 4)) % 4;
  const total = 12 + 8 + js.length + jpad + 8 + bin.length + bpad;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, js.length + jpad, true); dv.setUint32(16, 0x4e4f534a, true);
  out.set(js, 20); out.fill(0x20, 20 + js.length, 20 + js.length + jpad);
  const bo = 20 + js.length + jpad;
  dv.setUint32(bo, bin.length + bpad, true); dv.setUint32(bo + 4, 0x004e4942, true);
  out.set(bin, bo + 8);
  js = new Uint8Array(0);
  return out;
}

const COMP: Record<number, { size: number; get: (dv: DataView, o: number) => number; norm: number }> = {
  5120: { size: 1, get: (d, o) => d.getInt8(o), norm: 127 },
  5121: { size: 1, get: (d, o) => d.getUint8(o), norm: 255 },
  5122: { size: 2, get: (d, o) => d.getInt16(o, true), norm: 32767 },
  5123: { size: 2, get: (d, o) => d.getUint16(o, true), norm: 65535 },
  5125: { size: 4, get: (d, o) => d.getUint32(o, true), norm: 1 },
  5126: { size: 4, get: (d, o) => d.getFloat32(o, true), norm: 1 },
};
const NCOMP: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/** An accessor as numbers (floats: normalised when the accessor says so), incl. byteStride and sparse. */
function readAccessor(g: Glb, idx: number): { data: Float64Array; count: number; n: number } {
  const a = g.json.accessors?.[idx];
  if (!a) throw new Error(`accessor ${idx} missing`);
  const n = NCOMP[a.type] ?? 1, c = COMP[a.componentType];
  if (!c) throw new Error(`accessor ${idx}: component type ${a.componentType}`);
  const count = a.count | 0;
  const data = new Float64Array(count * n);
  const dv = new DataView(g.bin.buffer, g.bin.byteOffset, g.bin.byteLength);
  const scale = a.normalized ? 1 / c.norm : 1;
  if (a.bufferView !== undefined) {
    const bv = g.json.bufferViews[a.bufferView];
    const stride = bv.byteStride || c.size * n;
    const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    for (let i = 0; i < count; i++) for (let k = 0; k < n; k++) data[i * n + k] = c.get(dv, base + i * stride + k * c.size) * scale;
  }
  if (a.sparse) {
    const s = a.sparse, ic = COMP[s.indices.componentType];
    const ibv = g.json.bufferViews[s.indices.bufferView], vbv = g.json.bufferViews[s.values.bufferView];
    const ib = (ibv.byteOffset ?? 0) + (s.indices.byteOffset ?? 0), vb = (vbv.byteOffset ?? 0) + (s.values.byteOffset ?? 0);
    for (let j = 0; j < s.count; j++) {
      const i = ic.get(dv, ib + j * ic.size);
      for (let k = 0; k < n; k++) data[i * n + k] = c.get(dv, vb + (j * n + k) * c.size) * scale;
    }
  }
  return { data, count, n };
}

/** Vertices a shape key moves (sparse targets: only their indices). */
function morphMoved(g: Glb, prim: any, count: number): Uint8Array {
  const moved = new Uint8Array(count);
  for (const t of prim.targets ?? []) {
    if (t.POSITION === undefined) continue;
    const a = g.json.accessors[t.POSITION];
    const d = readAccessor(g, t.POSITION).data;
    const eps = 1e-5;
    void a;
    for (let i = 0; i < count; i++) if (Math.abs(d[i * 3]) + Math.abs(d[i * 3 + 1]) + Math.abs(d[i * 3 + 2]) > eps) moved[i] = 1;
  }
  return moved;
}

const HAIR_RE = /hair|bang|fringe|ahoge|pony|braid|twintail|pigtail|lock_|kami/i;
const FACE_RE = /face|head|eye|iris|pupil|lash|brow|mouth|teeth|tooth|tongue|cheek|blush|lip|nose|ear(?!th)/i;

/** Node sets from the skeleton: the head bone's own subtree minus hair (FACE), hair bones (HAIR). */
function boneRegions(json: Record<string, any>): { face: Set<number>; hair: Set<number> } {
  const nodes: any[] = json.nodes ?? [];
  const parent = new Map<number, number>();
  nodes.forEach((n, i) => (n.children ?? []).forEach((c: number) => parent.set(c, i)));
  let head = -1;
  const vrm0 = json.extensions?.VRM?.humanoid?.humanBones as { bone: string; node: number }[] | undefined;
  const vrm1 = json.extensions?.VRMC_vrm?.humanoid?.humanBones as Record<string, { node: number }> | undefined;
  if (vrm0) head = vrm0.find((b) => b.bone === 'head')?.node ?? -1;
  if (head < 0 && vrm1?.head) head = vrm1.head.node;
  if (head < 0) head = nodes.findIndex((n) => /(^|[_:.\s|])head$/i.test(String(n.name ?? '')) || /^J_Bip_C_Head$/i.test(String(n.name ?? '')));
  const face = new Set<number>(), hair = new Set<number>();
  nodes.forEach((n, i) => { if (HAIR_RE.test(String(n.name ?? ''))) hair.add(i); });
  const under = (i: number, root: number) => { for (let p: number | undefined = i; p !== undefined; p = parent.get(p)) if (p === root) return true; return false; };
  const inHair = (i: number) => { for (let p: number | undefined = i; p !== undefined; p = parent.get(p)) if (hair.has(p)) return true; return false; };
  if (head >= 0) nodes.forEach((_, i) => { if (under(i, head) && !inHair(i)) face.add(i); });
  nodes.forEach((_, i) => { if (inHair(i)) hair.add(i); });
  return { face, hair };
}

/** Triangles hidden under another surface (the body under clothes, a shirt under a jacket, anything under the worn
 *  costume): 9 rays from the triangle's outside (its normal ≤ 2 cm, 4 tilted 35° and 4 tilted 65° ≤ 3.4 cm, scaled
 *  to the model's height) all hit other geometry. They are dropped first — nobody sees them, and an under-layer left in place pokes through once the
 *  layer above is simplified. Skinned meshes are tested in bind space, others with their node transforms. */
export function hiddenTriangles(glbs: Glb[]): Map<any, Uint8Array> {
  const parts: { prim: any; idx: Float64Array; pos: Float32Array; nrm: Float32Array | null; ntri: number }[] = [];
  let total = 0;
  const box = new THREE.Box3();
  glbs.forEach((g) => {
    const json = g.json, nodes: any[] = json.nodes ?? [];
    const world = new Map<number, THREE.Matrix4>();
    const local = (n: any) => (n.matrix ? new THREE.Matrix4().fromArray(n.matrix) : new THREE.Matrix4().compose(new THREE.Vector3(...(n.translation ?? [0, 0, 0])), new THREE.Quaternion(...(n.rotation ?? [0, 0, 0, 1])), new THREE.Vector3(...(n.scale ?? [1, 1, 1]))));
    const walk = (i: number, parent: THREE.Matrix4) => { if (world.has(i) || !nodes[i]) return; const m = parent.clone().multiply(local(nodes[i])); world.set(i, m); for (const c of nodes[i].children ?? []) walk(c, m); };
    for (const sc of json.scenes ?? []) for (const r of sc.nodes ?? []) walk(r, new THREE.Matrix4());
    nodes.forEach((n, ni) => {
      if (typeof n.mesh !== 'number') return;
      const mat = typeof n.skin === 'number' ? new THREE.Matrix4() : world.get(ni) ?? new THREE.Matrix4();
      for (const p of json.meshes?.[n.mesh]?.primitives ?? []) {
        if ((p.mode ?? 4) !== 4 || p.attributes?.POSITION === undefined || parts.some((x) => x.prim === p)) continue;
        const raw = readAccessor(g, p.attributes.POSITION).data;
        const pos = new Float32Array(raw.length);
        const v = new THREE.Vector3();
        for (let i = 0; i < raw.length; i += 3) { v.set(raw[i], raw[i + 1], raw[i + 2]).applyMatrix4(mat); pos[i] = v.x; pos[i + 1] = v.y; pos[i + 2] = v.z; box.expandByPoint(v); }
        const idx = p.indices !== undefined ? readAccessor(g, p.indices).data : Float64Array.from({ length: raw.length / 3 }, (_, i) => i);
        const ntri = Math.floor(idx.length / 3);
        // the authored shading normals say which side is OUTSIDE (winding is often flipped on cloth / double-sided parts)
        let nrm: Float32Array | null = null;
        if (p.attributes.NORMAL !== undefined) {
          const rn = readAccessor(g, p.attributes.NORMAL).data, nm = new THREE.Matrix3().getNormalMatrix(mat);
          nrm = new Float32Array(rn.length);
          for (let i = 0; i < rn.length; i += 3) { v.set(rn[i], rn[i + 1], rn[i + 2]).applyMatrix3(nm); nrm[i] = v.x; nrm[i + 1] = v.y; nrm[i + 2] = v.z; }
        }
        parts.push({ prim: p, idx, pos, nrm, ntri }); total += ntri;
      }
    });
  });
  const out = new Map<any, Uint8Array>();
  if (!total) return out;
  const soup = new Float32Array(total * 9);
  let o = 0;
  for (const pt of parts) for (let t = 0; t < pt.ntri; t++) for (let k = 0; k < 3; k++) { const vi = pt.idx[t * 3 + k] * 3; soup[o++] = pt.pos[vi]; soup[o++] = pt.pos[vi + 1]; soup[o++] = pt.pos[vi + 2]; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(soup, 3));
  const bvh = new MeshBVH(geo);
  const size = box.getSize(new THREE.Vector3());
  const scale = Math.max(size.x, size.y, size.z) || 1;
  const D = scale * 0.02, eps = scale * 1e-4;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), t1 = new THREE.Vector3(), t2 = new THREE.Vector3(), d = new THREE.Vector3();
  const ray = new THREE.Ray();
  const dirs: [number, number][] = [[0, 0]];
  for (const deg of [35, 65]) { const tt = Math.tan(THREE.MathUtils.degToRad(deg)); for (const [x, y] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) dirs.push([x * tt, y * tt]); }
  let base = 0;
  for (const pt of parts) {
    const hid = new Uint8Array(pt.ntri);
    for (let t = 0; t < pt.ntri; t++) {
      const s = (base + t) * 9;
      a.fromArray(soup, s); b.fromArray(soup, s + 3); c.fromArray(soup, s + 6);
      t1.subVectors(b, a); t2.subVectors(c, a); n.crossVectors(t1, t2);
      if (n.lengthSq() < 1e-20) continue;
      n.normalize();
      if (pt.nrm) {
        const sn = new THREE.Vector3();
        for (let k = 0; k < 3; k++) { const vi = pt.idx[t * 3 + k] * 3; sn.x += pt.nrm[vi]; sn.y += pt.nrm[vi + 1]; sn.z += pt.nrm[vi + 2]; }
        if (sn.dot(n) < 0) n.negate();
      }
      t1.normalize(); t2.crossVectors(n, t1);
      const cen = a.add(b).add(c).multiplyScalar(1 / 3);
      let covered = true;
      for (const [x, y] of dirs) {
        d.copy(n).addScaledVector(t1, x).addScaledVector(t2, y).normalize();
        ray.origin.copy(cen).addScaledVector(n, eps); ray.direction.copy(d);
        const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
        if (!hit || hit.distance > (x === 0 && y === 0 ? D * 0.6 : D)) { covered = false; break; }
      }
      if (covered) hid[t] = 1;
    }
    out.set(pt.prim, hid);
    base += pt.ntri;
  }
  geo.dispose();
  return out;
}

interface Group { prim: any; file: number; mesh: string; material: string; region: Region | 'tiny'; tris: Uint32Array; lock: Uint8Array; positions: Float32Array; attrs: Float32Array; vcount: number; target: number; out: Uint32Array | null; error: number }
export interface LodPrimReport { file: number; mesh: string; material: string; region: Region | 'tiny'; from: number; to: number; locked: number; error: number }
export interface LodResult { files: Uint8Array[]; from: number; to: number; target: number; groups: LodPrimReport[]; warnings: string[]; /** hidden under-layer triangles dropped */ hidden: number }

type Simplifier = { ready: Promise<void>; simplifyWithAttributes: (i: Uint32Array, p: Float32Array, ps: number, a: Float32Array, as: number, w: number[], lock: Uint8Array | null, t: number, e: number, f?: string[]) => [Uint32Array, number] };
let simp: Simplifier | null = null;
async function simplifier(): Promise<Simplifier> {
  if (simp) return simp;
  try {
    const m = await import('meshoptimizer') as unknown as { MeshoptSimplifier: Simplifier };
    await m.MeshoptSimplifier.ready;
    return (simp = m.MeshoptSimplifier);
  } catch (e) { throw new Error(`party versions need the meshoptimizer package (npm install): ${(e as Error).message}`); }
}

/** Reduce one or more GLBs (the avatar + its worn costume) to ≤ `target` triangles together. */
export async function buildPartyLod(srcs: Uint8Array[], target: number): Promise<LodResult> {
  const S = await simplifier();
  const glbs = srcs.map(readGlb);
  for (const g of glbs) if (g.json.buffers?.[0]?.uri !== undefined) throw new Error('party versions need a self-contained GLB / VRM (its buffer is an external or data URI)');
  const from = glbs.reduce((a, g) => a + gltfStats(g.json).tris, 0);
  const warnings: string[] = [];
  const groups: Group[] = [];
  const hidden = hiddenTriangles(glbs);
  let dropped = 0;
  // ---- collect triangle groups per primitive × region
  glbs.forEach((g, fi) => {
    const json = g.json;
    const { face: faceBones, hair: hairBones } = boneRegions(json);
    // mesh → the skin its node uses (joints: skin joint index → node)
    const skinOf = new Map<number, number[]>();
    (json.nodes ?? []).forEach((n: any) => { if (typeof n.mesh === 'number' && typeof n.skin === 'number') skinOf.set(n.mesh, json.skins?.[n.skin]?.joints ?? []); });
    // vertices shared between primitives (material splits, separate face / body meshes): locked everywhere
    const posKey = new Map<string, number>();
    const primPos: { prim: any; pos: Float64Array }[] = [];
    (json.meshes ?? []).forEach((m: any) => (m.primitives ?? []).forEach((p: any) => {
      if ((p.mode ?? 4) !== 4 || p.attributes?.POSITION === undefined) return;
      const pos = readAccessor(g, p.attributes.POSITION).data;
      primPos.push({ prim: p, pos });
      const seen = new Set<string>();
      for (let i = 0; i < pos.length; i += 3) { const k = `${pos[i].toFixed(5)},${pos[i + 1].toFixed(5)},${pos[i + 2].toFixed(5)}`; if (!seen.has(k)) { seen.add(k); posKey.set(k, (posKey.get(k) ?? 0) + 1); } }
    }));
    (json.meshes ?? []).forEach((m: any, mi: number) => (m.primitives ?? []).forEach((p: any) => {
      if ((p.mode ?? 4) !== 4) return;
      const pp = primPos.find((x) => x.prim === p);
      if (!pp) return;
      const vcount = pp.pos.length / 3;
      const idx = p.indices !== undefined ? readAccessor(g, p.indices).data : Float64Array.from({ length: vcount }, (_, i) => i);
      const ntri = Math.floor(idx.length / 3);
      const matName = String(json.materials?.[p.material]?.name ?? '');
      const meshName = String(m.name ?? '');
      const positions = Float32Array.from(pp.pos);
      // attributes the error metric keeps: normals (shading edges) + UV0 (texture seams stay put)
      const nrm = p.attributes.NORMAL !== undefined ? readAccessor(g, p.attributes.NORMAL).data : null;
      const uv = p.attributes.TEXCOORD_0 !== undefined ? readAccessor(g, p.attributes.TEXCOORD_0).data : null;
      const attrs = new Float32Array(vcount * 5);
      for (let i = 0; i < vcount; i++) { if (nrm) { attrs[i * 5] = nrm[i * 3]; attrs[i * 5 + 1] = nrm[i * 3 + 1]; attrs[i * 5 + 2] = nrm[i * 3 + 2]; } if (uv) { attrs[i * 5 + 3] = uv[i * 2]; attrs[i * 5 + 4] = uv[i * 2 + 1]; } }
      const lockBase = new Uint8Array(vcount);
      for (let i = 0; i < vcount; i++) {
        const k = `${pp.pos[i * 3].toFixed(5)},${pp.pos[i * 3 + 1].toFixed(5)},${pp.pos[i * 3 + 2].toFixed(5)}`;
        if ((posKey.get(k) ?? 0) > 1) lockBase[i] = 1;
      }
      const tris = new Uint32Array(idx.length - (idx.length % 3));
      for (let i = 0; i < tris.length; i++) tris[i] = idx[i];
      // small parts are kept whole: eyes, lids, teeth (< 400 triangles) and drawn face plates / mouths (< 5,000)
      if (ntri < TINY || (ntri < 5000 && !HAIR_RE.test(meshName + ' ' + matName) && FACE_RE.test(meshName + ' ' + matName))) { groups.push({ prim: p, file: fi, mesh: meshName, material: matName, region: 'tiny', tris, lock: lockBase, positions, attrs, vcount, target: ntri, out: tris, error: 0 }); return; }
      // per-vertex region: shape-key-moved or head-bone vertices = face; hair bones / hair-named = hair; else body
      const moved = morphMoved(g, p, vcount);
      const vreg = new Uint8Array(vcount);                 // 0 body, 1 face, 2 hair
      const joints = skinOf.get(mi);
      const nameHair = HAIR_RE.test(meshName) || HAIR_RE.test(matName), nameFace = !nameHair && FACE_RE.test(meshName + ' ' + matName);
      if (p.attributes.JOINTS_0 !== undefined && p.attributes.WEIGHTS_0 !== undefined && joints) {
        const J = readAccessor(g, p.attributes.JOINTS_0).data, W = readAccessor(g, p.attributes.WEIGHTS_0).data;
        for (let i = 0; i < vcount; i++) {
          let best = -1, bw = -1;
          for (let k = 0; k < 4; k++) if (W[i * 4 + k] > bw) { bw = W[i * 4 + k]; best = J[i * 4 + k]; }
          const node = joints[best];
          vreg[i] = hairBones.has(node) ? 2 : faceBones.has(node) ? 3 : 0;
        }
      }
      for (let i = 0; i < vcount; i++) { if (moved[i]) vreg[i] = 1; else if (nameHair) vreg[i] = 2; else if (nameFace && (vreg[i] === 0 || vreg[i] === 3)) vreg[i] = 1; }
      // triangles by majority region
      const lists: Record<Region, number[]> = { face: [], head: [], hair: [], body: [] };
      const regOf = (r: number): Region => (r === 1 ? 'face' : r === 2 ? 'hair' : r === 3 ? 'head' : 'body');
      const hid = hidden.get(p);
      for (let t = 0; t < ntri; t++) {
        const a = vreg[tris[t * 3]], b = vreg[tris[t * 3 + 1]], c = vreg[tris[t * 3 + 2]];
        const r = a === b || a === c ? a : b === c ? b : 0;
        if (r === 0 && hid?.[t]) { dropped++; continue; }                  // hidden under-layer (body / clothes only)
        lists[regOf(r)].push(tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2]);
      }
      // vertices on a region boundary are locked in both regions (no cracks)
      const regsOfV = new Uint8Array(vcount);
      (['face', 'head', 'hair', 'body'] as Region[]).forEach((r, bit) => { for (const v of lists[r]) regsOfV[v] |= 1 << bit; });
      for (const r of ['face', 'head', 'hair', 'body'] as Region[]) {
        if (!lists[r].length) continue;
        const lock = new Uint8Array(lockBase);
        for (let i = 0; i < vcount; i++) if (regsOfV[i] & (regsOfV[i] - 1)) lock[i] = 1;
        if (r === 'face') for (let i = 0; i < vcount; i++) if (moved[i]) lock[i] = 1;      // expressions keep their density
        groups.push({ prim: p, file: fi, mesh: meshName, material: matName, region: r, tris: Uint32Array.from(lists[r]), lock, positions, attrs, vcount, target: 0, out: null, error: 0 });
      }
    }));
  });
  // ---- budget: bisection on k with weights, floors, the tiny groups fixed
  const fixed = groups.filter((g) => g.region === 'tiny').reduce((a, g) => a + g.tris.length / 3, 0);
  const free = groups.filter((g) => g.region !== 'tiny');
  // (every group keeps ≥ 40 % (up to 1,500) / 60 triangles: small clothing parts — belts, chokers, collars — keep their shape)
  const floorOf = (n: number) => Math.min(n, Math.max(60, Math.min(1500, Math.round(n * 0.4))));
  const targetFor = (g: Group, k: number) => { const n = g.tris.length / 3; return Math.min(n, Math.max(floorOf(n), Math.floor(k * WEIGHT[g.region as Region] * n))); };
  const plan = (set: Group[], k: number) => set.reduce((a, g) => a + targetFor(g, k), 0);
  const solveK = (set: Group[], b: number) => { let lo = 0, hi = 1 / Math.min(...Object.values(WEIGHT)); for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (plan(set, m) > b) hi = m; else lo = m; } return lo; };
  const run = (g: Group, tgt: number, err: number, permissive: boolean) => {
    const n = g.tris.length / 3;
    g.target = tgt;
    if (tgt >= n) { g.out = g.tris; g.error = 0; return; }
    // permissive (never the face): collapses may cross UV / normal seams, guided by a strong UV attribute error
    const perm = permissive && g.region !== 'face';
    const [res, e] = S.simplifyWithAttributes(g.tris, g.positions, 3, g.attrs, 5, [0.25, 0.25, 0.25, UVW, UVW], g.lock, tgt * 3, err, perm ? ['Permissive'] : []);
    g.out = res; g.error = e;
  };
  const total = () => fixed + free.reduce((a, g) => a + (g.out ? g.out.length / 3 : 0), 0);
  const budget = Math.max(0, target - fixed);
  if (budget <= 0) warnings.push('the small parts alone (eyes, lids, teeth) are over the target');
  let got = from;
  // A) seams kept (no permissive): quality-bounded first, then unbounded; a group that can't get down to its share
  //    (UV seams everywhere, locks) keeps what it reached and the others share the rest of the budget
  let active = [...free];
  let k = solveK(active, budget);
  for (let iter = 0; iter < 8 && active.length; iter++) {
    for (const g of active) run(g, targetFor(g, k), iter === 0 ? 0.05 : 1, false);
    got = total();
    if (got <= target) break;
    const sat = active.filter((g) => (g.out?.length ?? 0) / 3 > g.target * 1.03 + 2);
    if (!sat.length) { if (iter > 0) break; continue; }
    active = active.filter((g) => !sat.includes(g));
    const kept = free.filter((g) => !active.includes(g)).reduce((a, g) => a + (g.out?.length ?? 0) / 3, 0);
    if (budget - kept <= 0) break;
    k = solveK(active, budget - kept);
  }
  // B) still over: only the missing triangles are taken, from the biggest body / clothes groups first (then hair,
  //    then head; never the face), starting from the seam-keeping result: there UV seams may move (can leave small
  //    texture flecks), so as little of the model as possible goes through it
  if (got > target) {
    let moved = 0;
    for (const tier of [['body'], ['body', 'hair'], ['body', 'hair', 'head']] as Region[][]) {
      for (let round = 0; round < 3 && got > target; round++) {
        const pool = free.filter((g) => tier.includes(g.region as Region) && g.out && g.out.length / 3 > floorOf(g.tris.length / 3));
        const size = pool.reduce((a, g) => a + g.out!.length / 3, 0);
        if (!size) break;
        const deficit = got - target + Math.ceil(target * 0.003);
        for (const g of pool) {
          const cur = g.out!.length / 3;
          const want = Math.max(floorOf(g.tris.length / 3), Math.floor(cur - deficit * (cur / size)));
          if (want >= cur) continue;
          const src = g.out!;
          const [res, e] = S.simplifyWithAttributes(src, g.positions, 3, g.attrs, 5, [0.25, 0.25, 0.25, 12, 12], g.lock, want * 3, 1, ['Permissive']);
          moved += cur - res.length / 3;
          g.out = res; g.error = Math.max(g.error, e); g.target = want;
        }
        got = total();
      }
      if (got <= target) break;
    }
    warnings.push(`UV seams had to move on ${fmtCount(moved)} triangles of the ${[...new Set(free.filter((g) => g.region !== 'face').map((g) => g.region))].join(' / ')} to reach the limit (small texture flecks possible there; the face is untouched)`);
  }
  if (got > target) warnings.push(`could only reach ${got} triangles (target ${target}): too much of the model is locked (shape keys / seams)`);
  // ---- write: new index accessors appended to each file's BIN chunk
  const files = glbs.map((g, fi) => {
    const json = structuredClone(g.json);
    const extra: Uint8Array[] = [];
    let binLen = g.bin.length + ((4 - (g.bin.length % 4)) % 4);
    const byPrim = new Map<any, Group[]>();
    for (const grp of groups) if (grp.file === fi) { const l = byPrim.get(grp.prim) ?? []; l.push(grp); byPrim.set(grp.prim, l); }
    // map original primitive objects → the cloned JSON's primitives (same order)
    const origPrims: any[] = [], newPrims: any[] = [];
    (g.json.meshes ?? []).forEach((m: any, mi: number) => (m.primitives ?? []).forEach((p: any, pi: number) => { origPrims.push(p); newPrims.push(json.meshes[mi].primitives[pi]); }));
    for (const [prim, gs] of byPrim) {
      const total = gs.reduce((a, x) => a + (x.out?.length ?? 0), 0);
      const merged = new Uint32Array(total);
      let o = 0;
      for (const x of gs) { if (x.out) { merged.set(x.out, o); o += x.out.length; } }
      const vcount = gs[0].vcount;
      const big = vcount > 65535;
      const bytes = big ? new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength) : new Uint8Array(Uint16Array.from(merged).buffer);
      const pad = (4 - (bytes.length % 4)) % 4;
      json.bufferViews ??= [];
      json.accessors ??= [];
      const bv = json.bufferViews.push({ buffer: 0, byteOffset: binLen, byteLength: bytes.length, target: 34963 }) - 1;
      let mn = Infinity, mx = -Infinity;
      for (const v of merged) { if (v < mn) mn = v; if (v > mx) mx = v; }
      const acc = json.accessors.push({ bufferView: bv, componentType: big ? 5125 : 5123, count: merged.length, type: 'SCALAR', ...(merged.length ? { min: [mn], max: [mx] } : {}) }) - 1;
      newPrims[origPrims.indexOf(prim)].indices = acc;
      extra.push(bytes, new Uint8Array(pad));
      binLen += bytes.length + pad;
    }
    const bin = new Uint8Array(binLen);
    bin.set(g.bin, 0);
    let off = g.bin.length + ((4 - (g.bin.length % 4)) % 4);
    for (const e of extra) { bin.set(e, off); off += e.length; }
    if (!json.buffers?.length) json.buffers = [{ byteLength: 0 }];
    json.buffers[0].byteLength = bin.length;
    json.asset = { ...(json.asset ?? {}), extras: { ...(json.asset?.extras ?? {}), vtpPartyLod: { v: LOD_VERSION, from: gltfStats(g.json).tris, target } } };
    return writeGlb(json, bin);
  });
  const to = files.reduce((a, f) => a + gltfStats(readGlb(f).json).tris, 0);
  const report: LodPrimReport[] = groups.map((g) => ({ file: g.file, mesh: g.mesh, material: g.material, region: g.region, from: g.tris.length / 3, to: (g.out?.length ?? 0) / 3, locked: g.lock.reduce((a, v) => a + v, 0), error: +g.error.toFixed(4) }));
  // ---- automatic review: the party version must be the same avatar with fewer triangles
  files.forEach((f, i) => {
    const bad = glbProblem(f);
    if (bad) throw new Error(`party version failed its check: ${bad}`);
    const a = glbs[i].json, b = readGlb(f).json;
    const sig = (j: any) => JSON.stringify({
      meshes: (j.meshes ?? []).map((m: any) => ({ n: m.name, t: m.extras?.targetNames, p: (m.primitives ?? []).map((p: any) => ({ a: p.attributes, t: p.targets, m: p.material, mode: p.mode })) })),
      skins: j.skins, nodes: (j.nodes ?? []).length, images: (j.images ?? []).length, materials: (j.materials ?? []).length, ext: j.extensions, used: j.extensionsUsed,
    });
    if (sig(a) !== sig(b)) throw new Error('party version failed its check: meshes / shape keys / skins / extensions differ from the source');
  });
  if (to > target) warnings.push(`party version has ${to} triangles (target ${target})`);
  return { files, from, to, target, groups: report, warnings, hidden: dropped };
}

// ---------------------------------------------------------------- the avatar's party version on disk (its own folder)

/** How the worker is started: the bundled dist-helper/party_lod.mjs on THIS Node (a release: no tsx, no tools/*.ts
 *  ship) when it exists, else tools/party_lod.ts through tsx (the source install). Pure, for tools/party_lod_unit.ts. */
export function partyLodCommand(root: string, exists: (p: string) => boolean = fs.existsSync): { args: string[]; bundled: boolean } {
  const bundled = path.join(root, 'dist-helper', 'party_lod.mjs');
  if (exists(bundled)) return { args: [bundled], bundled: true };
  return { args: ['--import', 'tsx', path.join(root, 'tools', 'party_lod.ts')], bundled: false };
}

/** The party LOD worker in a child Node (process.execPath = the bundled runtime in a release), below-normal priority,
 *  3 min cap; resolves its JSON summary. Started on the off-loop worker thread (server/spawnOffLoop.ts): spawn() itself
 *  holds the event loop for 60-250 ms on Windows, and this loop relays the tracking frames to OBS. */
async function runChild(src: string, out: string, target: number, cos: [string, string] | null): Promise<{ to: number; warnings: string[] }> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const args = [...partyLodCommand(root).args, src, out, '--max', String(target), '--json', ...(cos ? ['--costume', ...cos] : [])];
  const r = await runOffLoop(process.execPath, args, { timeoutMs: 180_000, cwd: root, lowPriority: true });
  const so = r.stdout.toString('utf8'), se = r.stderr;
  try {
    if (r.error) throw new Error(r.error);
    const j = JSON.parse(so.trim().split(/\r?\n/).pop() ?? '');
    if (j.error) throw new Error(j.error);
    if (r.code !== 0) throw new Error(`exit ${r.code}`);
    return j;
  } catch (e) { throw new Error(`${(e as Error).message} ${se.slice(-300)}`.trim()); }
}

interface LodEntry { key: string; model: string; costume: string | null; srcTris: number; tris: number; warnings: string[]; at: string }
const LOD_DIR = 'party';
const statusFile = (id: string) => path.join(userDir(id), LOD_DIR, 'lod.json');
const readEntries = (id: string): Record<string, LodEntry> => { try { return JSON.parse(fs.readFileSync(statusFile(id), 'utf8')); } catch { return {}; } };
const fileKey = (f: string) => { const s = fs.statSync(f); return `${s.size}:${Math.round(s.mtimeMs)}`; };

/** Where things stand for this avatar + costume + limit; with `build`, make the party version when it's needed and
 *  missing / stale (`force`: always rebuild). Only .glb / .vrm models (+ .glb costumes) can get one. */
export async function partyLod(id: string, o: { max?: unknown; costume?: string | null; build?: boolean; force?: boolean }): Promise<PartyLodStatus> {
  const p = requireProfile(id);
  const max = clampTrisLimit(o.max);
  const cid = o.costume ?? p.costume ?? null;
  const def = cid ? p.costumes.find((c) => c.id === cid) ?? null : null;
  const src = resolveAvatarFile(id, p.modelFile);
  const csrc = def ? resolveAvatarFile(id, def.file) : null;
  const none: PartyLodStatus = { needed: false, ready: false, max, srcTris: 0, tris: 0, model: null, costume: null, costumeId: def?.id ?? null, warnings: [] };
  if (!src || !/\.(glb|vrm)$/i.test(src)) return { ...none, error: 'only .glb / .vrm models can get a party version' };
  const cOk = !!csrc && /\.glb$/i.test(csrc);
  const srcTris = (fileStats(src)?.tris ?? 0) + (cOk ? fileStats(csrc!)?.tris ?? 0 : 0);
  if (srcTris <= max) return { ...none, srcTris, tris: srcTris };
  const key = `v${LOD_VERSION}|${max}|${fileKey(src)}|${csrc ? fileKey(csrc) : '-'}`;
  const slot = def?.id ?? '-';
  const entries = readEntries(id);
  const e = entries[slot];
  const fresh = !!e && e.key === key && !!resolveAvatarFile(id, e.model) && (!e.costume || !!resolveAvatarFile(id, e.costume));
  const status = (x: LodEntry): PartyLodStatus => ({ needed: true, ready: true, max, srcTris, tris: x.tris, model: x.model, costume: x.costume, costumeId: def?.id ?? null, warnings: x.warnings });
  if (fresh && !o.force) return status(e);
  if (!o.build) return { ...none, needed: true, srcTris };
  const dir = path.join(userDir(id), LOD_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(src).toLowerCase();
  const tag = slot === '-' ? 'base' : slot.replace(/[^A-Za-z0-9_-]/g, '_');
  const mName = `lod-${tag}${ext}`, cName = cOk ? `lod-${tag}.costume.glb` : null;
  // leave a little headroom under the limit (receivers count exactly the same way); built in a low-priority child process (ray tests + simplification take 1–8 s: never block this server's bus)
  const r = await runChild(src, path.join(dir, mName + '.tmp'), Math.max(1000, max - 100), cOk ? [csrc!, path.join(dir, cName + '.tmp')] : null);
  if (r.to > max) throw new Error(`couldn’t get under ${max} triangles (reached ${r.to}): ${r.warnings.join('; ')}`);
  fs.renameSync(path.join(dir, mName + '.tmp'), path.join(dir, mName));
  if (cName) fs.renameSync(path.join(dir, cName + '.tmp'), path.join(dir, cName));
  const entry: LodEntry = { key, model: `${LOD_DIR}/${mName}`, costume: cName ? `${LOD_DIR}/${cName}` : null, srcTris, tris: r.to, warnings: r.warnings, at: new Date().toISOString() };
  entries[slot] = entry;
  fs.writeFileSync(statusFile(id), JSON.stringify(entries, null, 2));
  return status(entry);
}
