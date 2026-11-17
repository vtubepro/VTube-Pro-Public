// GLB reading / writing for the "Add my room" check (shared/roomCheck.ts, shared/roomSeats.ts). Pure TypeScript, no
// three.js and no node:* imports, so the browser, the server (server/routes/roomImport.ts) and
// the tests all run the SAME code.
//
//   parseGlb(bytes)              → { json, bin }                  (throws a plain-language Error on a bad file)
//   writeGlb(json, bin)          → bytes                          (JSON chunk re-written, BIN chunk kept byte for byte)
//   worldMatrices(json)          → a 4×4 column-major world matrix per node (scene 0 hierarchy; unreached nodes = identity)
//   triangleSoup(json, bin)      → world-space triangles of every readable mesh (uncompressed accessors only)
//   addRoomNodes(json, nodes)    → appends empties / cameras to scene 0 (the "add seats" fix: a lossless JSON edit)
//   wrapRoot(json, m)            → puts every root of scene 0 under a new node with matrix m (scale / up-axis / floor fix)
//
// glTF space everywhere: metres, +Y up, the stage front = +Z (docs/ARTIST_ENVIRONMENTS.md §2-3).

export interface GltfNode {
  name?: string; children?: number[]; mesh?: number; camera?: number;
  matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[];
  extras?: Record<string, unknown>; extensions?: Record<string, unknown>;
}
export interface GltfJson {
  asset?: { version?: string; generator?: string };
  scene?: number; scenes?: { name?: string; nodes?: number[]; extras?: Record<string, unknown> }[];
  nodes?: GltfNode[];
  meshes?: { name?: string; primitives: { attributes: Record<string, number>; indices?: number; mode?: number; material?: number; extensions?: Record<string, unknown> }[] }[];
  accessors?: { bufferView?: number; byteOffset?: number; componentType: number; normalized?: boolean; count: number; type: string; min?: number[]; max?: number[]; sparse?: unknown }[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number; extensions?: Record<string, unknown> }[];
  buffers?: { byteLength: number; uri?: string }[];
  materials?: { name?: string; extensions?: Record<string, unknown> }[];
  cameras?: { type: string; name?: string; perspective?: { yfov: number; znear: number; zfar?: number; aspectRatio?: number } }[];
  images?: { uri?: string; mimeType?: string; bufferView?: number }[];
  textures?: unknown[];
  extensionsUsed?: string[]; extensionsRequired?: string[];
  [k: string]: unknown;
}
export interface Glb { json: GltfJson; bin: Uint8Array | null }

const MAGIC = 0x46546c67, CHUNK_JSON = 0x4e4f534a, CHUNK_BIN = 0x004e4942;

const asBytes = (b: ArrayBuffer | Uint8Array): Uint8Array => (b instanceof Uint8Array ? b : new Uint8Array(b));

/** True when the bytes start like a binary glTF ("glTF"). */
export const isGlb = (b: ArrayBuffer | Uint8Array) => { const u = asBytes(b); return u.length >= 12 && u[0] === 0x67 && u[1] === 0x6c && u[2] === 0x54 && u[3] === 0x46; };

export function parseGlb(bytes: ArrayBuffer | Uint8Array): Glb {
  const u = asBytes(bytes);
  if (u.length > 0 && u[0] === 0x7b) {        // '{' = a .gltf (JSON) file: fine only when everything is embedded
    let json: GltfJson;
    try { json = JSON.parse(new TextDecoder().decode(u)) as GltfJson; } catch { throw new Error('This .gltf file is not valid. Export the room again as .glb.'); }
    const external = [...(json.buffers ?? []), ...(json.images ?? [])].some((b) => (b as { uri?: string }).uri && !String((b as { uri?: string }).uri).startsWith('data:'));
    if (external) throw new Error('This .gltf file needs other files next to it (.bin or textures). Export the room as one .glb file instead.');
    const b0 = json.buffers?.[0]?.uri;
    const bin = b0 ? dataUri(b0) : null;
    if (bin && json.buffers?.[0]) delete json.buffers[0].uri;
    return { json, bin };
  }
  if (u.length < 20) throw new Error('This file is empty or cut off. Export the room again.');
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('This is not a .glb file. Export the room as glTF Binary (.glb).');
  const total = Math.min(dv.getUint32(8, true), u.length);
  let off = 12, json: GltfJson | null = null, bin: Uint8Array | null = null;
  while (off + 8 <= total) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
    const body = u.subarray(off + 8, Math.min(off + 8 + len, total));
    if (type === CHUNK_JSON && !json) {
      try { json = JSON.parse(new TextDecoder().decode(body)) as GltfJson; } catch { throw new Error('The inside of this .glb is damaged. Export the room again.'); }
    } else if (type === CHUNK_BIN && !bin) bin = body;
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new Error('The inside of this .glb is damaged. Export the room again.');
  return { json, bin };
}

function dataUri(uri: string): Uint8Array | null {
  const m = /^data:[^,]*;base64,(.*)$/s.exec(uri);
  if (!m) return null;
  const s = atob(m[1]);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** A GLB from glTF JSON + the binary chunk (kept exactly; only the JSON is re-encoded). */
export function writeGlb(json: GltfJson, bin: Uint8Array | null): Uint8Array {
  if (bin && json.buffers?.[0]) json.buffers[0].byteLength = bin.length;
  const enc = new TextEncoder().encode(JSON.stringify(json));
  const jpad = (4 - (enc.length % 4)) % 4, bpad = bin ? (4 - (bin.length % 4)) % 4 : 0;
  const jlen = enc.length + jpad, blen = bin ? bin.length + bpad : 0;
  const total = 12 + 8 + jlen + (bin ? 8 + blen : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jlen, true); dv.setUint32(16, CHUNK_JSON, true);
  out.set(enc, 20);
  for (let i = 0; i < jpad; i++) out[20 + enc.length + i] = 0x20;
  if (bin) {
    const o = 20 + jlen;
    dv.setUint32(o, blen, true); dv.setUint32(o + 4, CHUNK_BIN, true);
    out.set(bin, o + 8);
  }
  return out;
}

// ---------------------------------------------------------------- matrices (4×4, column-major like glTF)
export type Mat4 = Float64Array;
export const identity = (): Mat4 => { const m = new Float64Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; };
export function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
export function compose(t: number[] = [0, 0, 0], q: number[] = [0, 0, 0, 1], s: number[] = [1, 1, 1]): Mat4 {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z, xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  const m = new Float64Array(16);
  m[0] = (1 - (yy + zz)) * s[0]; m[1] = (xy + wz) * s[0]; m[2] = (xz - wy) * s[0];
  m[4] = (xy - wz) * s[1]; m[5] = (1 - (xx + zz)) * s[1]; m[6] = (yz + wx) * s[1];
  m[8] = (xz + wy) * s[2]; m[9] = (yz - wx) * s[2]; m[10] = (1 - (xx + yy)) * s[2];
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; m[15] = 1;
  return m;
}
export const localMatrix = (n: GltfNode): Mat4 => (Array.isArray(n.matrix) && n.matrix.length === 16 ? Float64Array.from(n.matrix) : compose(n.translation, n.rotation, n.scale));
export const apply = (m: Mat4, x: number, y: number, z: number): [number, number, number] =>
  [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
/** The direction a matrix turns local +Z into (not normalised). */
export const dirZ = (m: Mat4): [number, number, number] => [m[8], m[9], m[10]];
export const dirNegZ = (m: Mat4): [number, number, number] => [-m[8], -m[9], -m[10]];

/** World matrix per node index, walking scene `json.scene ?? 0`. Nodes the scene never reaches get identity + `reached` false. */
export function worldMatrices(json: GltfJson): { world: Mat4[]; reached: boolean[]; parent: number[] } {
  const nodes = json.nodes ?? [];
  const world: Mat4[] = nodes.map(() => identity());
  const reached = nodes.map(() => false), parent = nodes.map(() => -1);
  const scene = json.scenes?.[json.scene ?? 0];
  const roots = scene?.nodes ?? nodes.map((_, i) => i).filter((i) => !nodes.some((n) => n.children?.includes(i)));
  const stack: [number, Mat4][] = roots.map((i) => [i, identity()]);
  let guard = 0;
  while (stack.length && guard++ < 200_000) {
    const [i, pm] = stack.pop()!;
    const n = nodes[i];
    if (!n || reached[i]) continue;
    reached[i] = true;
    world[i] = mul(pm, localMatrix(n));
    for (const c of n.children ?? []) { if (parent[c] < 0) parent[c] = i; stack.push([c, world[i]]); }
  }
  return { world, reached, parent };
}

// ---------------------------------------------------------------- accessors → triangles
const COMP: Record<number, [number, (dv: DataView, o: number) => number, number]> = {
  5120: [1, (dv, o) => dv.getInt8(o), 127], 5121: [1, (dv, o) => dv.getUint8(o), 255],
  5122: [2, (dv, o) => dv.getInt16(o, true), 32767], 5123: [2, (dv, o) => dv.getUint16(o, true), 65535],
  5125: [4, (dv, o) => dv.getUint32(o, true), 4294967295], 5126: [4, (dv, o) => dv.getFloat32(o, true), 1],
};
const NCOMP: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/** Read an accessor as numbers (null = compressed / sparse / external: we can't read it here). */
export function readAccessor(json: GltfJson, bin: Uint8Array | null, idx: number): Float64Array | null {
  const a = json.accessors?.[idx];
  if (!a || a.sparse || a.bufferView === undefined || !bin) return null;
  const bv = json.bufferViews?.[a.bufferView];
  if (!bv || bv.buffer !== 0 || bv.extensions) return null;      // EXT_meshopt_compression etc.: not readable here
  const c = COMP[a.componentType], nc = NCOMP[a.type];
  if (!c || !nc) return null;
  const [size, get, max] = c;
  const stride = bv.byteStride || size * nc;
  const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  if (base + stride * (a.count - 1) + size * nc > bin.length) return null;
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const out = new Float64Array(a.count * nc);
  const norm = a.normalized && a.componentType !== 5126;
  for (let i = 0; i < a.count; i++) for (let k = 0; k < nc; k++) {
    const v = get(dv, base + i * stride + k * size);
    out[i * nc + k] = norm ? Math.max(v / max, -1) : v;
  }
  return out;
}

export interface TriangleSoup {
  /** 9 numbers per triangle: world-space a, b, c (glTF space). */
  tris: Float32Array;
  count: number;
  /** Meshes we could not read (compressed / sparse), by node name. */
  unreadable: string[];
}

/** Node-name filter: COLLIDE_* boxes are invisible walk blockers, never seats or walls the camera sees. */
export const SOUP_SKIP = /^(COLLIDE_|SCREEN|SPOT_|CAM_)/;

/** Every readable triangle of scene 0, in world space. `maxTris` caps the work (larger meshes are sampled evenly). */
export function triangleSoup(json: GltfJson, bin: Uint8Array | null, opts: { maxTris?: number; skip?: RegExp } = {}): TriangleSoup {
  const { world, reached } = worldMatrices(json);
  const skip = opts.skip ?? SOUP_SKIP;
  const nodes = json.nodes ?? [];
  const unreadable: string[] = [];
  const parts: Float32Array[] = [];
  let count = 0;
  const posCache = new Map<number, Float64Array | null>(), idxCache = new Map<number, Float64Array | null>();
  const cached = (m: Map<number, Float64Array | null>, i: number) => { if (!m.has(i)) m.set(i, readAccessor(json, bin, i)); return m.get(i)!; };
  let total = 0;
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    if (n.mesh === undefined || !reached[ni]) continue;
    for (const p of json.meshes?.[n.mesh]?.primitives ?? []) {
      const pa = p.attributes?.POSITION;
      if ((p.mode ?? 4) === 4 && pa !== undefined) total += p.indices !== undefined ? (json.accessors?.[p.indices]?.count ?? 0) / 3 : (json.accessors?.[pa]?.count ?? 0) / 3;
    }
  }
  const keep = opts.maxTris && total > opts.maxTris ? opts.maxTris / total : 1;
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    if (n.mesh === undefined || !reached[ni]) continue;
    if (skip.test(stripArea(n.name ?? ''))) continue;
    const m = world[ni];
    for (const p of json.meshes?.[n.mesh]?.primitives ?? []) {
      if ((p.mode ?? 4) !== 4) continue;
      if (p.extensions && 'KHR_draco_mesh_compression' in p.extensions) { unreadable.push(n.name ?? `node ${ni}`); continue; }
      const pos = p.attributes?.POSITION !== undefined ? cached(posCache, p.attributes.POSITION) : null;
      if (!pos) { unreadable.push(n.name ?? `node ${ni}`); continue; }
      const idx = p.indices !== undefined ? cached(idxCache, p.indices) : null;
      if (p.indices !== undefined && !idx) { unreadable.push(n.name ?? `node ${ni}`); continue; }
      const nt = Math.floor((idx ? idx.length : pos.length / 3) / 3);
      const step = keep < 1 ? 1 / keep : 1;
      const take = Math.max(1, Math.floor(nt / step));
      const out = new Float32Array(take * 9);
      let w = 0;
      for (let t = 0; t < take; t++) {
        const ti = Math.min(nt - 1, Math.floor(t * step));
        for (let k = 0; k < 3; k++) {
          const vi = idx ? idx[ti * 3 + k] : ti * 3 + k;
          const [x, y, z] = apply(m, pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]);
          out[w++] = x; out[w++] = y; out[w++] = z;
        }
      }
      parts.push(out); count += take;
    }
  }
  const tris = new Float32Array(count * 9);
  let o = 0;
  for (const p of parts) { tris.set(p, o); o += p.length; }
  return { tris, count, unreadable: [...new Set(unreadable)] };
}

/** `BAR__SPOT_01` → `SPOT_01` (an area prefix, docs/SCENES.md "Areas"). */
export const stripArea = (name: string) => name.replace(/^[A-Z0-9][A-Z0-9_-]{0,23}__/, '');
/** `BAR__SPOT_01` → `BAR`; `SPOT_01` → ''. */
export const areaPrefix = (name: string) => /^([A-Z0-9][A-Z0-9_-]{0,23})__/.exec(name)?.[1] ?? '';

// ---------------------------------------------------------------- edits (lossless JSON changes)
export interface NewEmpty { kind: 'empty'; name: string; position: [number, number, number]; yawDeg: number; extras?: Record<string, unknown> }
export interface NewCamera { kind: 'camera'; name: string; position: [number, number, number]; target: [number, number, number]; yfovDeg?: number }
export type NewNode = NewEmpty | NewCamera;

/** Quaternion [x,y,z,w] of a yaw (deg) about +Y: yaw 0 = facing +Z. */
export function yawQuat(yawDeg: number): [number, number, number, number] {
  const h = (yawDeg * Math.PI) / 360;
  return [0, Math.sin(h), 0, Math.cos(h)];
}
/** Quaternion that turns a glTF camera (looking down its local −Z, +Y up) to look from `from` at `to` (no roll). */
export function lookQuat(from: number[], to: number[]): [number, number, number, number] {
  let fx = to[0] - from[0], fy = to[1] - from[1], fz = to[2] - from[2];
  const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
  // camera axes: z = -forward, x = up × z, y = z × x
  const zx = -fx, zy = -fy, zz = -fz;
  let xx = zz, xy = 0, xz = -zx;                      // (0,1,0) × z
  const xl = Math.hypot(xx, xy, xz);
  if (xl < 1e-6) { xx = 1; xy = 0; xz = 0; } else { xx /= xl; xy /= xl; xz /= xl; }
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  // rotation matrix columns x, y, z → quaternion
  const m00 = xx, m01 = yx, m02 = zx, m10 = xy, m11 = yy, m12 = zy, m20 = xz, m21 = yz, m22 = zz;
  const tr = m00 + m11 + m22;
  let qx: number, qy: number, qz: number, qw: number;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; qw = s / 4; qx = (m21 - m12) / s; qy = (m02 - m20) / s; qz = (m10 - m01) / s; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; qw = (m21 - m12) / s; qx = s / 4; qy = (m01 + m10) / s; qz = (m02 + m20) / s; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; qw = (m02 - m20) / s; qx = (m01 + m10) / s; qy = s / 4; qz = (m12 + m21) / s; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; qw = (m10 - m01) / s; qx = (m02 + m20) / s; qy = (m12 + m21) / s; qz = s / 4; }
  return [qx, qy, qz, qw];
}

const r5 = (v: number) => Math.round(v * 1e5) / 1e5;

/** Append empties / cameras as roots of scene 0. Existing nodes with the same name are replaced in place (so running
 *  the fix twice never duplicates SPOT_01). Returns the names written. */
export function addRoomNodes(json: GltfJson, add: NewNode[]): string[] {
  json.nodes ??= []; json.scenes ??= [{ nodes: [] }];
  const scene = json.scenes[json.scene ?? 0] ?? (json.scenes[0] ??= { nodes: [] });
  scene.nodes ??= [];
  const done: string[] = [];
  for (const a of add) {
    const node: GltfNode = { name: a.name };
    if (a.kind === 'empty') {
      node.translation = a.position.map(r5);
      node.rotation = yawQuat(a.yawDeg).map(r5);
      if (a.extras && Object.keys(a.extras).length) node.extras = a.extras;
    } else {
      json.cameras ??= [];
      const yfov = ((a.yfovDeg ?? 38) * Math.PI) / 180;
      json.cameras.push({ type: 'perspective', name: a.name, perspective: { yfov: r5(yfov), znear: 0.05, zfar: 400, aspectRatio: 16 / 9 } });
      node.camera = json.cameras.length - 1;
      node.translation = a.position.map(r5);
      node.rotation = lookQuat(a.position, a.target).map(r5);
    }
    const same = json.nodes.findIndex((n) => n.name === a.name);
    if (same >= 0 && scene.nodes.includes(same) && !json.nodes[same].mesh && !json.nodes[same].children?.length) json.nodes[same] = node;
    else { json.nodes.push(node); scene.nodes.push(json.nodes.length - 1); }
    done.push(a.name);
  }
  json.asset ??= { version: '2.0' };
  return done;
}

/** Put every root of scene 0 under one new parent with matrix `m` (column-major): fixes units, up axis and floor height
 *  without touching a single vertex. Returns the new node's index. */
export function wrapRoot(json: GltfJson, m: Mat4, name = 'VTP_ROOM_FIX'): number {
  json.nodes ??= []; json.scenes ??= [{ nodes: [] }];
  const scene = json.scenes[json.scene ?? 0] ?? json.scenes[0];
  const kids = [...(scene.nodes ?? [])];
  json.nodes.push({ name, children: kids, matrix: Array.from(m, r5) });
  scene.nodes = [json.nodes.length - 1];
  return json.nodes.length - 1;
}
