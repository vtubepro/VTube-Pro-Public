// "Just drop a model": the small glTF toolkit the import detection and auto-fixes share. Pure (no DOM, no three.js),
// runs in the studio (browser), in the helper (Node) and in the unit tests (tools/model_import_unit.ts).
//   - read a .glb / .vrm / .gltf (+ its external .bin / textures from a dropped folder or zip) into { json, buffers }
//   - read accessors (positions, inverse bind matrices, joints / weights), node world matrices
//   - write a single-file GLB (external files packed in: the "texture relinking" fix)
//   - the file-level fixes: a root node that turns a Z-up file upright and scales centimetres to metres
// Docs: docs/ARTIST_AVATARS.md §2 (units and axes), docs/AVATARS_SIMPLE.md "Drop a model anywhere".

export type Json = Record<string, any>;
export type Mat4 = Float64Array; // column-major, like glTF

export interface GltfDoc {
  json: Json;
  /** buffers[i] = the bytes of json.buffers[i] (null = missing: an external .bin that wasn't dropped with the model). */
  buffers: (Uint8Array | null)[];
}

const te = new TextEncoder();
const td = new TextDecoder();

// ---------------------------------------------------------------- read

export const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a, CHUNK_BIN = 0x004e4942;

export function isGlb(b: Uint8Array): boolean {
  return b.byteLength >= 12 && new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, true) === GLB_MAGIC;
}

/** A GLB's JSON + BIN chunks. Throws a plain-words Error for a damaged file. */
export function parseGlb(b: Uint8Array): GltfDoc {
  if (!isGlb(b)) throw new Error('not a GLB');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const version = dv.getUint32(4, true), total = dv.getUint32(8, true);
  if (version !== 2) throw new Error(version === 1 ? 'This is a glTF 1.0 file (2015). VTube Pro reads glTF 2.0: open it in Blender and export it again as .glb.' : `Unknown glTF version ${version}.`);
  if (total > b.byteLength + 8) throw new Error('This file is cut off (the download or copy didn’t finish). Copy or download it again.');
  let off = 12, json: Json | null = null, bin: Uint8Array | null = null;
  while (off + 8 <= Math.min(total, b.byteLength)) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
    const start = off + 8, end = start + len;
    if (end > b.byteLength) throw new Error('This file is cut off (the download or copy didn’t finish). Copy or download it again.');
    if (type === CHUNK_JSON && !json) {
      try { json = JSON.parse(td.decode(b.subarray(start, end))); } catch { throw new Error('This model file is damaged (its description can’t be read). Export it again.'); }
    } else if (type === CHUNK_BIN && !bin) bin = b.subarray(start, end);
    off = end + ((4 - (len % 4)) % 4);
  }
  if (!json || typeof json !== 'object') throw new Error('This model file is damaged (no description inside). Export it again.');
  const buffers = (Array.isArray(json.buffers) ? json.buffers : []).map((bf: Json, i: number) => {
    if (bf && typeof bf.uri === 'string') return decodeDataUri(bf.uri);
    return i === 0 ? bin : null;
  });
  return { json, buffers };
}

/** Looks a relative uri up among the dropped files (folder / zip): exact path, then case-insensitive, then by file name. */
export type FileLookup = (uri: string) => { path: string; bytes: Uint8Array } | null;

/** A .gltf (text) + whatever external files the lookup finds. Missing ones stay null (reported, never thrown). */
export function parseGltfText(text: Uint8Array | string, lookup: FileLookup | null): { doc: GltfDoc; missing: string[]; found: string[] } {
  let json: Json;
  try { json = JSON.parse(typeof text === 'string' ? text : td.decode(text)); } catch { throw new Error('This .gltf file is damaged (it isn’t valid JSON). Export it again, ideally as .glb.'); }
  if (!json || typeof json !== 'object' || !json.asset) throw new Error('This .gltf file has no glTF description inside. Export it again, ideally as .glb.');
  if (String(json.asset.version ?? '').startsWith('1')) throw new Error('This is a glTF 1.0 file (2015). VTube Pro reads glTF 2.0: open it in Blender and export it again as .glb.');
  const missing: string[] = [], found: string[] = [];
  const buffers = (Array.isArray(json.buffers) ? json.buffers : []).map((bf: Json) => {
    if (!bf || typeof bf.uri !== 'string') return null;
    const d = decodeDataUri(bf.uri);
    if (d) return d;
    const f = lookup?.(decodeUri(bf.uri)) ?? null;
    if (f) { found.push(f.path); return f.bytes; }
    missing.push(decodeUri(bf.uri));
    return null;
  });
  return { doc: { json, buffers }, missing, found };
}

export function decodeUri(u: string): string {
  try { return decodeURIComponent(u); } catch { return u; }
}

export function decodeDataUri(uri: string): Uint8Array | null {
  const m = /^data:[^;,]*(;base64)?,(.*)$/s.exec(uri);
  if (!m) return null;
  if (!m[1]) return te.encode(decodeUri(m[2]));
  return b64decode(m[2]);
}

export function b64decode(s: string): Uint8Array {
  const A = typeof atob === 'function' ? atob : (x: string) => Buffer.from(x, 'base64').toString('binary');
  const bin = A(s.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------- accessors

const COMP: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const NCOMP: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

/** An accessor's values as numbers (normalised ints are scaled to 0..1 / -1..1). Sparse accessors are applied.
 *  null = no data (missing buffer, bad indices). Bounded: at most `maxCount` elements are read. */
export function readAccessor(doc: GltfDoc, index: number, maxCount = 5_000_000): { data: Float32Array; n: number; count: number } | null {
  const a = doc.json.accessors?.[index];
  if (!a) return null;
  const n = NCOMP[a.type], cs = COMP[a.componentType];
  if (!n || !cs) return null;
  const count = Math.min(Number(a.count) || 0, maxCount);
  const out = new Float32Array(count * n);
  if (a.bufferView !== undefined) {
    const bv = doc.json.bufferViews?.[a.bufferView];
    const buf = bv ? doc.buffers[bv.buffer] : null;
    if (!bv || !buf) return null;
    const stride = bv.byteStride || n * cs;
    const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
    if (base + (count - 1) * stride + n * cs > buf.byteLength && count > 0) return null;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    for (let i = 0; i < count; i++) for (let k = 0; k < n; k++) out[i * n + k] = readComp(dv, base + i * stride + k * cs, a.componentType, !!a.normalized);
  }
  const sp = a.sparse;
  if (sp && sp.count > 0) {
    const ib = doc.json.bufferViews?.[sp.indices?.bufferView], vb = doc.json.bufferViews?.[sp.values?.bufferView];
    const ibuf = ib ? doc.buffers[ib.buffer] : null, vbuf = vb ? doc.buffers[vb.buffer] : null;
    if (!ib || !vb || !ibuf || !vbuf) return null;
    const idv = new DataView(ibuf.buffer, ibuf.byteOffset, ibuf.byteLength), vdv = new DataView(vbuf.buffer, vbuf.byteOffset, vbuf.byteLength);
    const ics = COMP[sp.indices.componentType] ?? 4;
    const ibase = (ib.byteOffset || 0) + (sp.indices.byteOffset || 0), vbase = (vb.byteOffset || 0) + (sp.values.byteOffset || 0);
    for (let s = 0; s < Math.min(sp.count, count); s++) {
      const at = readComp(idv, ibase + s * ics, sp.indices.componentType, false);
      if (at >= count) continue;
      for (let k = 0; k < n; k++) out[at * n + k] = readComp(vdv, vbase + (s * n + k) * cs, a.componentType, !!a.normalized);
    }
  }
  return { data: out, n, count };
}

function readComp(dv: DataView, o: number, t: number, norm: boolean): number {
  switch (t) {
    case 5126: return dv.getFloat32(o, true);
    case 5121: { const v = dv.getUint8(o); return norm ? v / 255 : v; }
    case 5123: { const v = dv.getUint16(o, true); return norm ? v / 65535 : v; }
    case 5125: return dv.getUint32(o, true);
    case 5120: { const v = dv.getInt8(o); return norm ? Math.max(v / 127, -1) : v; }
    case 5122: { const v = dv.getInt16(o, true); return norm ? Math.max(v / 32767, -1) : v; }
  }
  return 0;
}

// ---------------------------------------------------------------- matrices

export function identity(): Mat4 { const m = new Float64Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; }

export function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}

export function fromTRS(t: number[] = [0, 0, 0], q: number[] = [0, 0, 0, 1], s: number[] = [1, 1, 1]): Mat4 {
  const [x, y, z, w] = q;
  const m = new Float64Array(16);
  const x2 = x + x, y2 = y + y, z2 = z + z, xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  m[0] = (1 - (yy + zz)) * s[0]; m[1] = (xy + wz) * s[0]; m[2] = (xz - wy) * s[0];
  m[4] = (xy - wz) * s[1]; m[5] = (1 - (xx + zz)) * s[1]; m[6] = (yz + wx) * s[1];
  m[8] = (xz + wy) * s[2]; m[9] = (yz - wx) * s[2]; m[10] = (1 - (xx + yy)) * s[2];
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; m[15] = 1;
  return m;
}

export function nodeLocal(n: Json): Mat4 {
  if (Array.isArray(n?.matrix) && n.matrix.length === 16) return Float64Array.from(n.matrix as number[]);
  return fromTRS(n?.translation, n?.rotation, n?.scale);
}

export function apply(m: Mat4, p: readonly number[]): [number, number, number] {
  const [x, y, z] = p;
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
}

/** World matrices of every node reachable from the default scene (others: their local chain from any root). */
export function worldMatrices(json: Json): { world: Mat4[]; parent: number[] } {
  const nodes: Json[] = Array.isArray(json.nodes) ? json.nodes : [];
  const parent = new Array<number>(nodes.length).fill(-1);
  nodes.forEach((n, i) => { for (const c of Array.isArray(n?.children) ? n.children : []) if (typeof c === 'number' && c >= 0 && c < nodes.length && parent[c] === -1 && c !== i) parent[c] = i; });
  const world: (Mat4 | null)[] = new Array(nodes.length).fill(null);
  const get = (i: number, depth = 0): Mat4 => {
    if (world[i]) return world[i]!;
    const local = nodeLocal(nodes[i]);
    const w = parent[i] >= 0 && depth < 512 ? mul(get(parent[i], depth + 1), local) : local;
    world[i] = w;
    return w;
  };
  for (let i = 0; i < nodes.length; i++) get(i);
  return { world: world as Mat4[], parent };
}

// ---------------------------------------------------------------- write

/** A single-file GLB from a doc: every buffer is merged into one BIN chunk; images with an external uri found by the
 *  lookup are packed in (bufferView + mimeType); images still missing are dropped from their materials. */
export function writeGlb(doc: GltfDoc, lookup: FileLookup | null = null): { glb: Uint8Array; packed: string[]; missing: string[] } {
  const json: Json = JSON.parse(JSON.stringify(doc.json));
  const parts: Uint8Array[] = [];
  let length = 0;
  const push = (b: Uint8Array) => { const at = length; parts.push(b); length += b.byteLength; const pad = (4 - (length % 4)) % 4; if (pad) { parts.push(new Uint8Array(pad)); length += pad; } return at; };
  // 1. old buffers → offsets in the merged one
  const shift: number[] = [];
  const oldBuffers: Json[] = Array.isArray(json.buffers) ? json.buffers : [];
  oldBuffers.forEach((_, i) => { const b = doc.buffers[i]; shift[i] = b ? push(b) : -1; });
  const views: Json[] = Array.isArray(json.bufferViews) ? json.bufferViews : [];
  const deadViews = new Set<number>();
  views.forEach((v, i) => {
    if (shift[v.buffer] === undefined || shift[v.buffer] < 0) { deadViews.add(i); return; }
    v.byteOffset = (v.byteOffset || 0) + shift[v.buffer];
    v.buffer = 0;
  });
  // 2. images
  const packed: string[] = [], missing: string[] = [];
  const deadImages = new Set<number>();
  (Array.isArray(json.images) ? json.images : []).forEach((im: Json, i: number) => {
    if (typeof im.bufferView === 'number') { if (deadViews.has(im.bufferView)) deadImages.add(i); return; }
    if (typeof im.uri !== 'string') { deadImages.add(i); return; }
    const data = decodeDataUri(im.uri);
    const ext = data ? null : lookup?.(decodeUri(im.uri)) ?? null;
    const bytes = data ?? ext?.bytes ?? null;
    if (!bytes) { missing.push(decodeUri(im.uri)); deadImages.add(i); return; }
    const mime = sniffImageMime(bytes) ?? im.mimeType ?? 'image/png';
    const at = push(bytes);
    views.push({ buffer: 0, byteOffset: at, byteLength: bytes.byteLength });
    delete im.uri;
    im.bufferView = views.length - 1;
    im.mimeType = mime;
    if (ext) packed.push(ext.path);
  });
  if (deadImages.size) dropImages(json, deadImages);
  if (deadViews.size) {
    // accessors on a missing .bin can't be read by anyone: report upstream (this keeps the file loadable only if unused)
    for (const a of Array.isArray(json.accessors) ? json.accessors : []) if (deadViews.has(a.bufferView)) delete a.bufferView;
  }
  json.bufferViews = views;
  json.buffers = length ? [{ byteLength: length }] : [];
  if (!length) delete json.buffers;
  if (!views.length) delete json.bufferViews;
  const bin = new Uint8Array(length);
  let o = 0;
  for (const p of parts) { bin.set(p, o); o += p.byteLength; }
  return { glb: packGlb(json, bin), packed, missing };
}

/** Removes images (and the textures using them) from materials so the file still loads. */
function dropImages(json: Json, dead: Set<number>) {
  const deadTex = new Set<number>();
  (Array.isArray(json.textures) ? json.textures : []).forEach((t: Json, i: number) => {
    const src = t?.source ?? t?.extensions?.EXT_texture_webp?.source ?? t?.extensions?.KHR_texture_basisu?.source;
    if (typeof src === 'number' && dead.has(src)) deadTex.add(i);
  });
  const strip = (o: unknown): void => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o as Json)) {
      if (v && typeof v === 'object' && typeof (v as Json).index === 'number' && /texture$/i.test(k) && deadTex.has((v as Json).index)) delete (o as Json)[k];
      else strip(v);
    }
  };
  for (const m of Array.isArray(json.materials) ? json.materials : []) strip(m);
}

export function packGlb(json: Json, bin: Uint8Array | null): Uint8Array {
  let j = te.encode(JSON.stringify(json));
  const jpad = (4 - (j.byteLength % 4)) % 4;
  if (jpad) { const t = new Uint8Array(j.byteLength + jpad); t.set(j); t.fill(0x20, j.byteLength); j = t; }
  const hasBin = !!bin && bin.byteLength > 0;
  const bpad = hasBin ? (4 - (bin!.byteLength % 4)) % 4 : 0;
  const total = 12 + 8 + j.byteLength + (hasBin ? 8 + bin!.byteLength + bpad : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, GLB_MAGIC, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, j.byteLength, true); dv.setUint32(16, CHUNK_JSON, true); out.set(j, 20);
  if (hasBin) {
    const o = 20 + j.byteLength;
    dv.setUint32(o, bin!.byteLength + bpad, true); dv.setUint32(o + 4, CHUNK_BIN, true); out.set(bin!, o + 8);
  }
  return out;
}

// ---------------------------------------------------------------- the file-level fixes

export interface RootFix {
  /** Turn the model upright: rotation about X in degrees (−90 = a Z-up file stands up), or about Z for a sideways file. */
  rotX?: number;
  rotZ?: number;
  /** Uniform scale (0.01 = centimetres → metres). */
  scale?: number;
}

/** Adds one root node (appended: no existing node index changes, so skins, animations and extensions stay valid) that
 *  carries the rotation + scale, and makes it the only root of every scene. */
export function applyRootFix(json: Json, fix: RootFix): Json {
  const rx = fix.rotX ?? 0, rz = fix.rotZ ?? 0, s = fix.scale ?? 1;
  if (!rx && !rz && s === 1) return json;
  const out: Json = JSON.parse(JSON.stringify(json));
  const nodes: Json[] = (out.nodes ??= []);
  const qx = [Math.sin((rx * Math.PI) / 360), 0, 0, Math.cos((rx * Math.PI) / 360)];
  const qz = [0, 0, Math.sin((rz * Math.PI) / 360), Math.cos((rz * Math.PI) / 360)];
  // q = qz * qx (X first, then Z)
  const q = [
    qz[3] * qx[0] + qz[0] * qx[3] + qz[1] * qx[2] - qz[2] * qx[1],
    qz[3] * qx[1] - qz[0] * qx[2] + qz[1] * qx[3] + qz[2] * qx[0],
    qz[3] * qx[2] + qz[0] * qx[1] - qz[1] * qx[0] + qz[2] * qx[3],
    qz[3] * qx[3] - qz[0] * qx[0] - qz[1] * qx[1] - qz[2] * qx[2],
  ].map((v) => Math.round(v * 1e9) / 1e9);
  const scenes: Json[] = Array.isArray(out.scenes) && out.scenes.length ? out.scenes : [{ nodes: rootsOf(out) }];
  out.scenes = scenes;
  for (const sc of scenes) {
    const root: Json = { name: 'vtp_import_root', children: Array.isArray(sc.nodes) ? sc.nodes.slice() : [] };
    if (rx || rz) root.rotation = q;
    if (s !== 1) root.scale = [s, s, s];
    nodes.push(root);
    sc.nodes = [nodes.length - 1];
  }
  if (typeof out.scene !== 'number') out.scene = 0;
  return out;
}

function rootsOf(json: Json): number[] {
  const nodes: Json[] = Array.isArray(json.nodes) ? json.nodes : [];
  const child = new Set<number>();
  for (const n of nodes) for (const c of Array.isArray(n?.children) ? n.children : []) child.add(c);
  return nodes.map((_, i) => i).filter((i) => !child.has(i));
}

/** The name three.js gives a node (GLTFLoader → PropertyBinding.sanitizeNodeName): whitespace → '_', [ ] . : / removed.
 *  Bone maps saved in a profile use these, because that's what the studio sees. */
export function sanitizeNodeName(name: string): string {
  return String(name).replace(/\s/g, '_').replace(/[\[\].:/]/g, '');
}

// ---------------------------------------------------------------- images

export function sniffImageMime(b: Uint8Array): string | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b.length >= 4 && b[0] === 0x44 && b[1] === 0x44 && b[2] === 0x53 && b[3] === 0x20) return 'image/vnd-ms.dds';
  if (b.length >= 12 && b[0] === 0xab && b[1] === 0x4b && b[2] === 0x54 && b[3] === 0x58) return 'image/ktx2';
  return null;
}

/** Width × height of a PNG / JPEG / WebP / GIF / BMP from its header (null = unknown). Also whether a PNG has alpha. */
export function imageSize(b: Uint8Array): { w: number; h: number; alpha?: boolean } | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const mime = sniffImageMime(b);
  try {
    if (mime === 'image/png' && b.length >= 26) {
      const ct = b[25];
      let alpha = ct === 4 || ct === 6;
      if (!alpha) { // a tRNS chunk before IDAT also means transparency
        let o = 8;
        while (o + 8 < b.length && o < 1 << 20) {
          const len = dv.getUint32(o), type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
          if (type === 'tRNS') { alpha = true; break; }
          if (type === 'IDAT') break;
          o += 12 + len;
        }
      }
      return { w: dv.getUint32(16), h: dv.getUint32(20), alpha };
    }
    if (mime === 'image/jpeg') {
      let o = 2;
      while (o + 9 < b.length) {
        if (b[o] !== 0xff) { o++; continue; }
        const m = b[o + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: dv.getUint16(o + 7), h: dv.getUint16(o + 5) };
        o += 2 + dv.getUint16(o + 2);
      }
      return null;
    }
    if (mime === 'image/gif') return { w: dv.getUint16(6, true), h: dv.getUint16(8, true) };
    if (mime === 'image/bmp' && b.length >= 26) return { w: Math.abs(dv.getInt32(18, true)), h: Math.abs(dv.getInt32(22, true)) };
    if (mime === 'image/webp' && b.length >= 30) {
      const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
      if (kind === 'VP8X') return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
      if (kind === 'VP8L') { const v = dv.getUint32(21, true); return { w: 1 + (v & 0x3fff), h: 1 + ((v >> 14) & 0x3fff) }; }
      if (kind === 'VP8 ') return { w: dv.getUint16(26, true) & 0x3fff, h: dv.getUint16(28, true) & 0x3fff };
    }
  } catch { /* short / odd header */ }
  return null;
}

/** The bytes of a glTF image (embedded bufferView or data: uri). */
export function imageBytes(doc: GltfDoc, index: number): Uint8Array | null {
  const im = doc.json.images?.[index];
  if (!im) return null;
  if (typeof im.uri === 'string') return decodeDataUri(im.uri);
  const bv = doc.json.bufferViews?.[im.bufferView];
  const buf = bv ? doc.buffers[bv.buffer] : null;
  if (!bv || !buf) return null;
  const s = bv.byteOffset || 0;
  return s + bv.byteLength <= buf.byteLength ? buf.subarray(s, s + bv.byteLength) : null;
}
