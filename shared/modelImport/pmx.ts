// "Just drop a model": MMD models (.pmx 2.0 / 2.1) → a glTF the studio loads like any GLB. Our own reader of the
// public PMX layout (no MMD code is used), pure: runs in the studio, the helper and the unit tests.
//   - MMD units are ~8 cm: scaled to metres (×0.08); MMD is left-handed: z is flipped and the triangle order reversed,
//     so the model faces +Z (the camera) with its left hand on +X, like every other avatar.
//   - BDEF1/2/4, SDEF (as BDEF2) and QDEF (as BDEF4) skinning → JOINTS_0 / WEIGHTS_0 over every PMX bone (Japanese names
//     kept; shared/modelImport/bones.ts maps them to the humanoid).
//   - one mesh per material; vertex morphs (and group morphs made of vertex morphs) become named morph targets on the
//     meshes they move (あ い う え お, まばたき, ウィンク …; morphs.ts maps them). Bone / UV / material morphs are skipped
//     (counted in the result).
//   - textures are looked up next to the .pmx (dropped folder / zip); PNG + JPEG go in as they are, other formats
//     (BMP / TGA / DDS …) through an optional converter (the studio decodes them in the browser).
// Docs: docs/AVATARS_SIMPLE.md "Drop a model anywhere". Tests: tools/model_import_unit.ts (a generated PMX).
import { sniffImageMime, imageSize, type FileLookup, type GltfDoc, type Json } from './gltf.ts';

export const MMD_TO_METRES = 0.08;

export interface PmxBone { name: string; nameEn: string; pos: [number, number, number]; parent: number; flags: number }
export interface PmxMaterial { name: string; nameEn: string; diffuse: [number, number, number, number]; flags: number; texture: number; faceCount: number }
export interface PmxMorph { name: string; nameEn: string; type: number; vertex?: { index: number; offset: [number, number, number] }[]; group?: { morph: number; weight: number }[] }
export interface PmxModel {
  version: number;
  name: string; nameEn: string; comment: string; commentEn: string;
  positions: Float32Array; normals: Float32Array; uvs: Float32Array;
  joints: Uint16Array; weights: Float32Array;
  indices: Uint32Array;
  textures: string[];
  materials: PmxMaterial[];
  bones: PmxBone[];
  morphs: PmxMorph[];
}

class Reader {
  o = 0;
  private dv: DataView;
  private td: TextDecoder;
  constructor(private b: Uint8Array, utf8 = false) { this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength); this.td = new TextDecoder(utf8 ? 'utf-8' : 'utf-16le'); }
  setText(utf8: boolean) { this.td = new TextDecoder(utf8 ? 'utf-8' : 'utf-16le'); }
  need(n: number) { if (this.o + n > this.b.byteLength) throw new Error('This .pmx file is cut off or damaged. Copy it again from the original download.'); }
  u8() { this.need(1); return this.b[this.o++]; }
  i8() { this.need(1); return this.dv.getInt8(this.o++); }
  u16() { this.need(2); const v = this.dv.getUint16(this.o, true); this.o += 2; return v; }
  i16() { this.need(2); const v = this.dv.getInt16(this.o, true); this.o += 2; return v; }
  i32() { this.need(4); const v = this.dv.getInt32(this.o, true); this.o += 4; return v; }
  f32() { this.need(4); const v = this.dv.getFloat32(this.o, true); this.o += 4; return v; }
  vec(n: number) { const a: number[] = []; for (let i = 0; i < n; i++) a.push(this.f32()); return a; }
  text() { const n = this.i32(); if (n < 0 || n > 1 << 20) throw new Error('This .pmx file is damaged (a name is unreadable).'); this.need(n); const s = this.td.decode(this.b.subarray(this.o, this.o + n)); this.o += n; return s; }
  idx(size: number) { return size === 1 ? this.i8() : size === 2 ? this.i16() : this.i32(); }
  vidx(size: number) { return size === 1 ? this.u8() : size === 2 ? this.u16() : this.i32(); }
  count(max: number) { const n = this.i32(); if (n < 0 || n > max) throw new Error('This .pmx file is damaged (impossible counts inside).'); return n; }
}

export function isPmx(b: Uint8Array) { return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4d && b[2] === 0x58 && b[3] === 0x20; }
export function isPmd(b: Uint8Array) { return b.length >= 3 && b[0] === 0x50 && b[1] === 0x6d && b[2] === 0x64; }

export function parsePmx(bytes: Uint8Array): PmxModel {
  if (!isPmx(bytes)) throw new Error('This isn’t a .pmx file.');
  const r = new Reader(bytes);
  r.o = 4;
  const version = Math.round(r.f32() * 10) / 10;
  const gc = r.u8();
  const g: number[] = [];
  for (let i = 0; i < gc; i++) g.push(r.u8());
  const [enc, addUv, vSize, tSize, mSize, bSize, morphSize] = g;
  r.setText(enc === 1);
  const name = r.text(), nameEn = r.text(), comment = r.text(), commentEn = r.text();
  // vertices
  const nv = r.count(4_000_000);
  const positions = new Float32Array(nv * 3), normals = new Float32Array(nv * 3), uvs = new Float32Array(nv * 2);
  const joints = new Uint16Array(nv * 4), weights = new Float32Array(nv * 4);
  for (let i = 0; i < nv; i++) {
    positions[i * 3] = r.f32(); positions[i * 3 + 1] = r.f32(); positions[i * 3 + 2] = r.f32();
    normals[i * 3] = r.f32(); normals[i * 3 + 1] = r.f32(); normals[i * 3 + 2] = r.f32();
    uvs[i * 2] = r.f32(); uvs[i * 2 + 1] = r.f32();
    r.o += 16 * (addUv || 0); r.need(0);
    const t = r.u8();
    const j = [0, 0, 0, 0], w = [0, 0, 0, 0];
    if (t === 0) { j[0] = r.idx(bSize); w[0] = 1; }
    else if (t === 1 || t === 3) { j[0] = r.idx(bSize); j[1] = r.idx(bSize); w[0] = r.f32(); w[1] = 1 - w[0]; if (t === 3) r.o += 36; }
    else if (t === 2 || t === 4) { for (let k = 0; k < 4; k++) j[k] = r.idx(bSize); for (let k = 0; k < 4; k++) w[k] = r.f32(); }
    else throw new Error('This .pmx file uses an unknown skinning type (damaged?).');
    r.f32(); // edge scale
    let sum = 0;
    for (let k = 0; k < 4; k++) { if (j[k] < 0 || w[k] < 0) { j[k] = 0; w[k] = 0; } sum += w[k]; }
    if (sum <= 0) { w[0] = 1; sum = 1; }
    for (let k = 0; k < 4; k++) { joints[i * 4 + k] = j[k]; weights[i * 4 + k] = w[k] / sum; }
  }
  // faces
  const ni = r.count(30_000_000);
  const indices = new Uint32Array(ni);
  for (let i = 0; i < ni; i++) indices[i] = r.vidx(vSize);
  // textures
  const textures: string[] = [];
  const nt = r.count(100_000);
  for (let i = 0; i < nt; i++) textures.push(r.text());
  // materials
  const materials: PmxMaterial[] = [];
  const nm = r.count(100_000);
  for (let i = 0; i < nm; i++) {
    const mn = r.text(), mne = r.text();
    const diffuse = r.vec(4) as [number, number, number, number];
    r.vec(3); r.f32(); r.vec(3); // specular, strength, ambient
    const flags = r.u8();
    r.vec(4); r.f32(); // edge colour, size
    const texture = r.idx(tSize);
    r.idx(tSize); r.u8(); // sphere texture + mode
    const toonRef = r.u8();
    if (toonRef === 0) r.idx(tSize); else r.u8();
    r.text(); // memo
    const faceCount = r.i32();
    materials.push({ name: mn, nameEn: mne, diffuse, flags, texture, faceCount });
  }
  // bones
  const bones: PmxBone[] = [];
  const nb = r.count(65_535);
  for (let i = 0; i < nb; i++) {
    const bn = r.text(), bne = r.text();
    const pos = r.vec(3) as [number, number, number];
    const parent = r.idx(bSize);
    r.i32(); // layer
    const flags = r.u16();
    if (flags & 0x0001) r.idx(bSize); else r.vec(3);
    if (flags & 0x0300) { r.idx(bSize); r.f32(); }
    if (flags & 0x0400) r.vec(3);
    if (flags & 0x0800) { r.vec(3); r.vec(3); }
    if (flags & 0x2000) r.i32();
    if (flags & 0x0020) {
      r.idx(bSize); r.i32(); r.f32();
      const links = r.count(10_000);
      for (let k = 0; k < links; k++) { r.idx(bSize); if (r.u8()) { r.vec(3); r.vec(3); } }
    }
    bones.push({ name: bn, nameEn: bne, pos, parent, flags });
  }
  // morphs (only what we need: vertex + group; the rest is skipped by size)
  const morphs: PmxMorph[] = [];
  let nmo = 0;
  try { nmo = r.count(100_000); } catch { nmo = 0; }
  for (let i = 0; i < nmo; i++) {
    const mn = r.text(), mne = r.text();
    r.u8(); // panel
    const type = r.u8();
    const n = r.count(10_000_000);
    const m: PmxMorph = { name: mn, nameEn: mne, type };
    if (type === 1) { m.vertex = []; for (let k = 0; k < n; k++) m.vertex.push({ index: r.vidx(vSize), offset: r.vec(3) as [number, number, number] }); }
    else if (type === 0 || type === 9) { m.group = []; for (let k = 0; k < n; k++) m.group.push({ morph: r.idx(morphSize), weight: r.f32() }); }
    else {
      const per = type === 2 ? bSize + 28 : type >= 3 && type <= 7 ? vSize + 16 : type === 8 ? mSize + 1 + 112 : type === 10 ? g[7] + 1 + 24 : -1;
      if (per < 0) break;
      r.need(per * n); r.o += per * n;
    }
    morphs.push(m);
  }
  return { version, name, nameEn, comment, commentEn, positions, normals, uvs, joints, weights, indices, textures, materials, bones, morphs };
}

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

export interface PmxConvertResult {
  doc: GltfDoc;
  meta: { name: string; comment: string; version: number };
  textures: { path: string; found: boolean; converted?: boolean }[];
  skippedMorphs: number;
  vertexMorphs: number;
}

/** PMX → a glTF doc (one buffer). `convertImage` turns a texture the glTF can't hold (BMP, TGA, DDS …) into PNG bytes. */
export async function pmxToGltf(bytes: Uint8Array, opts: { lookup?: FileLookup | null; baseDir?: string; convertImage?: (b: Uint8Array, name: string) => Promise<Uint8Array | null> } = {}): Promise<PmxConvertResult> {
  const pmx = parsePmx(bytes);
  const S = MMD_TO_METRES;
  const nb = pmx.bones.length;
  const parts: Uint8Array[] = [];
  let length = 0;
  const views: Json[] = [], accessors: Json[] = [];
  const addView = (data: ArrayBufferView, target?: number) => {
    const b = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const pad = (4 - (length % 4)) % 4;
    if (pad) { parts.push(new Uint8Array(pad)); length += pad; }
    views.push({ buffer: 0, byteOffset: length, byteLength: b.byteLength, ...(target ? { target } : {}) });
    parts.push(b.slice()); length += b.byteLength;
    return views.length - 1;
  };
  const addAcc = (data: Float32Array | Uint16Array | Uint32Array, type: string, n: number, extra: Json = {}, target?: number) => {
    const ct = data instanceof Float32Array ? 5126 : data instanceof Uint16Array ? 5123 : 5125;
    accessors.push({ bufferView: addView(data, target), componentType: ct, count: data.length / n, type, ...extra });
    return accessors.length - 1;
  };
  const minmax = (a: Float32Array) => {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < a.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], a[i + k]); mx[k] = Math.max(mx[k], a[i + k]); }
    return a.length ? { min: mn, max: mx } : { min: [0, 0, 0], max: [0, 0, 0] };
  };

  // ---- bones → nodes 0..nb-1
  const nodes: Json[] = pmx.bones.map((b) => {
    const p = b.parent >= 0 && b.parent < nb ? pmx.bones[b.parent].pos : [0, 0, 0];
    return { name: b.name || b.nameEn || 'bone', translation: [(b.pos[0] - p[0]) * S, (b.pos[1] - p[1]) * S, -(b.pos[2] - p[2]) * S], ...(b.nameEn ? { extras: { nameEn: b.nameEn } } : {}) };
  });
  const roots: number[] = [];
  pmx.bones.forEach((b, i) => {
    if (b.parent >= 0 && b.parent < nb && b.parent !== i) (nodes[b.parent].children ??= []).push(i);
    else roots.push(i);
  });
  // a parent loop would hang every loader: break it
  const seen = new Uint8Array(nb);
  const walk = (i: number, depth: number) => { if (seen[i] || depth > 512) return; seen[i] = 1; for (const c of nodes[i].children ?? []) walk(c, depth + 1); };
  roots.forEach((r) => walk(r, 0));
  for (let i = 0; i < nb; i++) if (!seen[i]) { for (const n of nodes) if (n.children) n.children = n.children.filter((c: number) => c !== i); roots.push(i); walk(i, 0); }
  const ibm = new Float32Array(nb * 16);
  pmx.bones.forEach((b, i) => { const o = i * 16; ibm[o] = ibm[o + 5] = ibm[o + 10] = ibm[o + 15] = 1; ibm[o + 12] = -b.pos[0] * S; ibm[o + 13] = -b.pos[1] * S; ibm[o + 14] = b.pos[2] * S; });

  // ---- morphs: vertex offsets per morph (group morphs of vertex morphs expanded)
  const vmorph = new Map<number, Map<number, [number, number, number]>>();
  pmx.morphs.forEach((m, i) => {
    if (m.type !== 1 || !m.vertex?.length) return;
    const mm = new Map<number, [number, number, number]>();
    for (const v of m.vertex) if (v.index >= 0 && v.index * 3 < pmx.positions.length) mm.set(v.index, [v.offset[0] * S, v.offset[1] * S, -v.offset[2] * S]);
    vmorph.set(i, mm);
  });
  let skippedMorphs = 0;
  pmx.morphs.forEach((m, i) => {
    if (m.type === 1) return;
    if (m.type === 0 && m.group?.length) {
      const mm = new Map<number, [number, number, number]>();
      for (const gi of m.group) {
        const src = vmorph.get(gi.morph);
        if (!src) continue;
        for (const [v, o] of src) { const cur = mm.get(v) ?? [0, 0, 0]; mm.set(v, [cur[0] + o[0] * gi.weight, cur[1] + o[1] * gi.weight, cur[2] + o[2] * gi.weight]); }
      }
      if (mm.size) { vmorph.set(i, mm); return; }
    }
    skippedMorphs++;
  });
  const morphIds = [...vmorph.keys()];
  // unique names (glTF / three key morphs by name)
  const morphNames = new Map<number, string>();
  const nameUse = new Map<string, number>();
  for (const i of morphIds) {
    const base = pmx.morphs[i].name || pmx.morphs[i].nameEn || `morph${i}`;
    const k = nameUse.get(base) ?? 0; nameUse.set(base, k + 1);
    morphNames.set(i, k ? `${base}_${k + 1}` : base);
  }

  // ---- textures → images (looked up next to the .pmx)
  const images: Json[] = [], texturesOut: Json[] = [], texInfo: PmxConvertResult['textures'] = [];
  const texIndex = new Map<number, { tex: number; alpha: boolean }>();
  const base = (opts.baseDir ?? '').replace(/\\/g, '/').replace(/\/?$/, opts.baseDir ? '/' : '');
  for (let t = 0; t < pmx.textures.length; t++) {
    const rel = pmx.textures[t].replace(/\\/g, '/');
    const f = opts.lookup?.(base + rel) ?? opts.lookup?.(rel) ?? null;
    if (!f) { texInfo.push({ path: rel, found: false }); continue; }
    let data: Uint8Array | null = f.bytes;
    let mime = sniffImageMime(data);
    let converted = false;
    if (mime !== 'image/png' && mime !== 'image/jpeg') {
      data = opts.convertImage ? await opts.convertImage(f.bytes, rel).catch(() => null) : null;
      mime = data ? sniffImageMime(data) : null;
      converted = !!data;
      if (!data || (mime !== 'image/png' && mime !== 'image/jpeg')) { texInfo.push({ path: rel, found: true, converted: false }); continue; }
    }
    const sz = imageSize(data);
    images.push({ name: rel.split('/').pop(), bufferView: addView(data), mimeType: mime });
    texturesOut.push({ source: images.length - 1, sampler: 0 });
    texIndex.set(t, { tex: texturesOut.length - 1, alpha: !!sz?.alpha });
    texInfo.push({ path: rel, found: true, ...(converted ? { converted: true } : {}) });
  }

  // ---- materials → one skinned mesh each
  const materials: Json[] = [], meshes: Json[] = [];
  const meshNodes: number[] = [];
  let face = 0;
  pmx.materials.forEach((m, mi) => {
    const count = Math.max(0, Math.min(m.faceCount, pmx.indices.length - face));
    const start = face;
    face += m.faceCount;
    if (count < 3) return;
    const tx = m.texture >= 0 ? texIndex.get(m.texture) : undefined;
    const soft = /頬|チーク|cheek|blush|影|shadow|透|glass|ガラス|涙|tear|ハイライト|highlight/i.test(`${m.name} ${m.nameEn}`);
    const mat: Json = {
      name: m.name || m.nameEn || `material ${mi}`,
      pbrMetallicRoughness: { baseColorFactor: [lin(m.diffuse[0]), lin(m.diffuse[1]), lin(m.diffuse[2]), Math.max(0, Math.min(1, m.diffuse[3]))], metallicFactor: 0, roughnessFactor: 0.9, ...(tx ? { baseColorTexture: { index: tx.tex } } : {}) },
      doubleSided: !!(m.flags & 0x01),
      ...(m.diffuse[3] < 0.999 || (tx?.alpha && soft) ? { alphaMode: 'BLEND' } : tx?.alpha ? { alphaMode: 'MASK', alphaCutoff: 0.4 } : {}),
      extras: { mmd: { edge: !!(m.flags & 0x10) } },
    };
    materials.push(mat);
    // the vertices this material uses
    const remap = new Map<number, number>();
    const idx = new Uint32Array(count - (count % 3));
    for (let k = 0; k + 2 < count; k += 3) {
      const tri = [pmx.indices[start + k], pmx.indices[start + k + 2], pmx.indices[start + k + 1]]; // reversed winding
      for (let q = 0; q < 3; q++) { let v = remap.get(tri[q]); if (v === undefined) { v = remap.size; remap.set(tri[q], v); } idx[k + q] = v; }
    }
    const nv = remap.size;
    const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), T = new Float32Array(nv * 2), J = new Uint16Array(nv * 4), W = new Float32Array(nv * 4);
    for (const [src, dst] of remap) {
      P[dst * 3] = pmx.positions[src * 3] * S; P[dst * 3 + 1] = pmx.positions[src * 3 + 1] * S; P[dst * 3 + 2] = -pmx.positions[src * 3 + 2] * S;
      let nx = pmx.normals[src * 3], ny = pmx.normals[src * 3 + 1], nz = -pmx.normals[src * 3 + 2];
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      N[dst * 3] = nx; N[dst * 3 + 1] = ny; N[dst * 3 + 2] = nz;
      T[dst * 2] = pmx.uvs[src * 2]; T[dst * 2 + 1] = pmx.uvs[src * 2 + 1];
      for (let k = 0; k < 4; k++) { const j = pmx.joints[src * 4 + k]; J[dst * 4 + k] = j < nb ? j : 0; W[dst * 4 + k] = j < nb ? pmx.weights[src * 4 + k] : 0; }
    }
    const mm = minmax(P);
    const attributes: Json = {
      POSITION: addAcc(P, 'VEC3', 3, mm, 34962), NORMAL: addAcc(N, 'VEC3', 3, {}, 34962), TEXCOORD_0: addAcc(T, 'VEC2', 2, {}, 34962),
      JOINTS_0: addAcc(J, 'VEC4', 4, {}, 34962), WEIGHTS_0: addAcc(W, 'VEC4', 4, {}, 34962),
    };
    const targets: Json[] = [], targetNames: string[] = [];
    for (const id of morphIds) {
      const mo = vmorph.get(id)!;
      let any = false;
      const D = new Float32Array(nv * 3);
      for (const [src, dst] of remap) { const o = mo.get(src); if (o) { D[dst * 3] = o[0]; D[dst * 3 + 1] = o[1]; D[dst * 3 + 2] = o[2]; any = true; } }
      if (!any) continue;
      targets.push({ POSITION: addAcc(D, 'VEC3', 3, minmax(D)) });
      targetNames.push(morphNames.get(id)!);
    }
    const prim: Json = { attributes, indices: addAcc(idx, 'SCALAR', 1, {}, 34963), material: materials.length - 1, mode: 4 };
    if (targets.length) prim.targets = targets;
    meshes.push({ name: mat.name, primitives: [prim], ...(targets.length ? { weights: targets.map(() => 0), extras: { targetNames } } : {}) });
    nodes.push({ name: mat.name, mesh: meshes.length - 1, skin: 0 });
    meshNodes.push(nodes.length - 1);
  });

  const ibmAcc = addAcc(ibm, 'MAT4', 16);
  const bin = new Uint8Array(length);
  let o = 0;
  for (const p of parts) { bin.set(p, o); o += p.byteLength; }
  const json: Json = {
    asset: { version: '2.0', generator: 'VTube Pro PMX import' },
    scene: 0, scenes: [{ nodes: [...roots, ...meshNodes] }],
    nodes, meshes, materials, accessors, bufferViews: views, buffers: [{ byteLength: length }],
    skins: [{ joints: pmx.bones.map((_, i) => i), inverseBindMatrices: ibmAcc, ...(roots.length ? { skeleton: roots[0] } : {}) }],
    ...(images.length ? { images, textures: texturesOut, samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }] } : {}),
    extras: { vtpImport: { from: 'pmx', name: pmx.name || pmx.nameEn } },
  };
  return {
    doc: { json, buffers: [bin] },
    meta: { name: pmx.name || pmx.nameEn, comment: (pmx.comment || pmx.commentEn).trim(), version: pmx.version },
    textures: texInfo, skippedMorphs, vertexMorphs: morphIds.length,
  };
}

// ---------------------------------------------------------------- a tiny PMX writer (tests + fixtures only)

export interface PmxWriteIn {
  name: string;
  positions: number[]; normals?: number[]; uvs?: number[];
  /** BDEF1 per vertex (bone index) or BDEF2 [b0, b1, w0]. */
  skin: (number | [number, number, number])[];
  indices: number[];
  textures?: string[];
  materials: { name: string; faceCount: number; texture?: number; diffuse?: [number, number, number, number] }[];
  bones: { name: string; pos: [number, number, number]; parent: number }[];
  morphs?: { name: string; vertex?: { index: number; offset: [number, number, number] }[]; group?: { morph: number; weight: number }[] }[];
}

/** Writes a PMX 2.0 (UTF-16, 4-byte indices) from plain arrays. Used to make test models: no real MMD model is ever
 *  stored in the repo. */
export function writePmx(m: PmxWriteIn): Uint8Array {
  const out: number[] = [];
  const dv = new DataView(new ArrayBuffer(8));
  const f32 = (v: number) => { dv.setFloat32(0, v, true); for (let i = 0; i < 4; i++) out.push(dv.getUint8(i)); };
  const i32 = (v: number) => { dv.setInt32(0, v, true); for (let i = 0; i < 4; i++) out.push(dv.getUint8(i)); };
  const u16 = (v: number) => { dv.setUint16(0, v, true); out.push(dv.getUint8(0), dv.getUint8(1)); };
  const text = (s: string) => { i32(s.length * 2); for (let i = 0; i < s.length; i++) u16(s.charCodeAt(i)); };
  out.push(0x50, 0x4d, 0x58, 0x20); f32(2.0);
  out.push(8, 0, 0, 4, 4, 4, 4, 4, 4);
  text(m.name); text(m.name); text('test model made by VTube Pro'); text('');
  const nv = m.positions.length / 3;
  i32(nv);
  for (let v = 0; v < nv; v++) {
    for (let k = 0; k < 3; k++) f32(m.positions[v * 3 + k]);
    for (let k = 0; k < 3; k++) f32(m.normals?.[v * 3 + k] ?? (k === 2 ? -1 : 0));
    f32(m.uvs?.[v * 2] ?? 0); f32(m.uvs?.[v * 2 + 1] ?? 0);
    const s = m.skin[v] ?? 0;
    if (Array.isArray(s)) { out.push(1); i32(s[0]); i32(s[1]); f32(s[2]); } else { out.push(0); i32(s); }
    f32(1);
  }
  i32(m.indices.length); for (const i of m.indices) i32(i);
  i32(m.textures?.length ?? 0); for (const t of m.textures ?? []) text(t);
  i32(m.materials.length);
  for (const mt of m.materials) {
    text(mt.name); text('');
    for (const c of mt.diffuse ?? [1, 1, 1, 1]) f32(c);
    f32(0); f32(0); f32(0); f32(5); f32(0.5); f32(0.5); f32(0.5);
    out.push(0x01 | 0x10);
    f32(0); f32(0); f32(0); f32(1); f32(1);
    i32(mt.texture ?? -1); i32(-1); out.push(0); out.push(1); out.push(0);
    text(''); i32(mt.faceCount);
  }
  i32(m.bones.length);
  for (const b of m.bones) { text(b.name); text(''); for (const c of b.pos) f32(c); i32(b.parent); i32(0); u16(0x0002 | 0x0008 | 0x0010); f32(0); f32(0); f32(0); }
  const mo = m.morphs ?? [];
  i32(mo.length);
  for (const x of mo) {
    text(x.name); text(''); out.push(3);
    if (x.group) { out.push(0); i32(x.group.length); for (const g of x.group) { i32(g.morph); f32(g.weight); } }
    else { out.push(1); i32(x.vertex?.length ?? 0); for (const v of x.vertex ?? []) { i32(v.index); for (const c of v.offset) f32(c); } }
  }
  i32(0); // display frames
  i32(0); i32(0); // rigid bodies, joints
  return Uint8Array.from(out);
}
