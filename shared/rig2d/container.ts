// .vtp2 container: a plain ZIP (so any archive tool can open it), written and read by this small self-contained code
// (no dependency). Writing stores entries uncompressed (PNG / WebP are compressed already; the manifest is small);
// reading accepts stored and deflated entries (deflate through an injected `inflateRaw`: node's zlib or the browser's
// DecompressionStream), so archives re-saved by other zip tools still load. Every offset / size is bounds-checked:
// .vtp2 files are untrusted input (party guests, downloads).
import { RIG2D, RIG2D_LIMITS, rig2dForStorage, validateRig2D, type BufferView, type Rig2DDoc, type Rig2DIssue } from './format.ts';

// ---------------------------------------------------------------- CRC-32
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(b: Uint8Array): number { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

// ---------------------------------------------------------------- write
export interface ZipEntryIn { name: string; data: Uint8Array }
/** A stored (uncompressed) zip. Entry order is kept (mimetype first). */
export function zipStore(entries: ZipEntryIn[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [], centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name), crc = crc32(e.data), n = e.data.length;
    const lh = new Uint8Array(30 + name.length), lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
    lv.setUint16(10, 0, true); lv.setUint16(12, 0x21, true); lv.setUint32(14, crc, true); lv.setUint32(18, n, true); lv.setUint32(22, n, true);
    lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true); lh.set(name, 30);
    const ch = new Uint8Array(46 + name.length), cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true); cv.setUint16(14, 0x21, true); cv.setUint32(16, crc, true); cv.setUint32(20, n, true); cv.setUint32(24, n, true);
    cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true); ch.set(name, 46);
    locals.push(lh, e.data); centrals.push(ch);
    offset += lh.length + n;
  }
  const cdSize = centrals.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true); ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let o = 0;
  for (const p of [...locals, ...centrals, end]) { out.set(p, o); o += p.length; }
  return out;
}

// ---------------------------------------------------------------- read
export interface ZipEntry { name: string; method: number; crc: number; size: number; csize: number; dataStart: number }
export class ZipError extends Error {}

/** List a zip's entries (central directory). */
export function zipEntries(b: Uint8Array, maxEntries = RIG2D_LIMITS.zipEntries): ZipEntry[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new ZipError('Not a zip archive.');
  const count = dv.getUint16(eocd + 10, true), cdSize = dv.getUint32(eocd + 12, true), cdOff = dv.getUint32(eocd + 16, true);
  if (count > maxEntries) throw new ZipError('Too many entries in the archive.');
  if (cdOff + cdSize > eocd) throw new ZipError('Broken zip directory.');
  const out: ZipEntry[] = [];
  const dec = new TextDecoder();
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (p + 46 > eocd || dv.getUint32(p, true) !== 0x02014b50) throw new ZipError('Broken zip directory entry.');
    const method = dv.getUint16(p + 10, true), crc = dv.getUint32(p + 16, true), csize = dv.getUint32(p + 20, true), size = dv.getUint32(p + 24, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true);
    if (p + 46 + nl > eocd) throw new ZipError('Broken zip directory entry.');
    const name = dec.decode(b.subarray(p + 46, p + 46 + nl));
    p += 46 + nl + xl + cl;
    if (lo + 30 > b.length || dv.getUint32(lo, true) !== 0x04034b50) throw new ZipError(`Broken zip entry ${name.slice(0, 60)}.`);
    const dataStart = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
    if (dataStart + csize > b.length) throw new ZipError(`Zip entry ${name.slice(0, 60)} runs past the end of the file.`);
    if (csize === 0xffffffff || size === 0xffffffff) throw new ZipError('ZIP64 archives are not supported.');
    out.push({ name, method, crc, size, csize, dataStart });
  }
  return out;
}

export type InflateRaw = (data: Uint8Array, expectedSize: number) => Uint8Array | Promise<Uint8Array>;

/** The entry's bytes (stored or deflated), CRC-checked. */
export async function zipRead(b: Uint8Array, e: ZipEntry, inflateRaw?: InflateRaw, maxSize = RIG2D_LIMITS.bufferBytes): Promise<Uint8Array> {
  if (e.size > maxSize) throw new ZipError(`${e.name.slice(0, 60)} is too big.`);
  const raw = b.subarray(e.dataStart, e.dataStart + e.csize);
  let out: Uint8Array;
  if (e.method === 0) out = raw.slice(); // a copy: callers may wipe the archive bytes (party custody)
  else if (e.method === 8) {
    if (!inflateRaw) throw new ZipError('Compressed entry and no inflater.');
    out = await inflateRaw(raw, e.size);
  } else throw new ZipError(`Unsupported zip compression (${e.method}).`);
  if (out.length !== e.size) throw new ZipError(`${e.name.slice(0, 60)} has the wrong size.`);
  if (crc32(out) !== e.crc) throw new ZipError(`${e.name.slice(0, 60)} is damaged (CRC).`);
  return out;
}

/** Browser inflater (DecompressionStream 'deflate-raw'). */
export const browserInflateRaw: InflateRaw = async (data, expected) => {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  const r = stream.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    n += value.length;
    if (n > expected) { await r.cancel(); throw new ZipError('Inflated data is bigger than declared.'); }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

// ---------------------------------------------------------------- .vtp2
export interface Rig2DPackage {
  doc: Rig2DDoc;
  /** buffers[i] = the bytes of doc.buffers[i] */
  buffers: Uint8Array[];
  /** every other file by archive path (textures, maps, thumb) */
  files: Map<string, Uint8Array>;
}

const SAFE_PATH = /^(?!\/)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9_\-./ ]{1,256}$/;

/** Write a .vtp2 archive. Buffer and texture paths come from the document; `files` supplies their bytes. */
export function writeVtp2(pkg: Rig2DPackage): Uint8Array {
  const enc = new TextEncoder();
  const entries: ZipEntryIn[] = [{ name: 'mimetype', data: enc.encode(RIG2D.mime) }, { name: RIG2D.manifest, data: enc.encode(JSON.stringify(rig2dForStorage(pkg.doc))) }];
  pkg.doc.buffers.forEach((b, i) => {
    const data = pkg.buffers[i];
    if (!data || data.length !== b.byteLength) throw new Error(`buffer ${i} size mismatch`);
    entries.push({ name: b.file, data });
  });
  for (const [name, data] of pkg.files) if (!entries.some((e) => e.name === name)) entries.push({ name, data });
  return zipStore(entries);
}

export interface ReadResult { ok: true; pkg: Rig2DPackage; warnings: string[] }
export interface ReadFail { ok: false; error: string; issues?: Rig2DIssue[] }

/** Is this a .vtp2 archive (zip whose first entry is our mimetype)? Cheap: looks at the first local header only. */
export function isVtp2(b: Uint8Array): boolean {
  if (b.length < 30 + 8) return false;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint32(0, true) !== 0x04034b50 || dv.getUint16(8, true) !== 0) return false;
  const nl = dv.getUint16(26, true), xl = dv.getUint16(28, true), size = dv.getUint32(22, true);
  if (nl !== 8 || 30 + nl + xl + size > b.length) return false;
  const dec = new TextDecoder();
  return dec.decode(b.subarray(30, 38)) === 'mimetype' && dec.decode(b.subarray(30 + nl + xl, 30 + nl + xl + size)) === RIG2D.mime;
}

/** Read + validate a .vtp2 archive. Never throws: broken / hostile input ends in { ok: false, error }. */
export async function readVtp2(bytes: Uint8Array, inflateRaw?: InflateRaw): Promise<ReadResult | ReadFail> {
  try {
    if (bytes.length > RIG2D_LIMITS.totalBytes) return { ok: false, error: 'The file is too big.' };
    const list = zipEntries(bytes);
    const byName = new Map(list.map((e) => [e.name, e]));
    const mt = byName.get('mimetype');
    if (!mt || new TextDecoder().decode(await zipRead(bytes, mt, inflateRaw, 256)) !== RIG2D.mime) return { ok: false, error: `Not a ${RIG2D.name} file.` };
    const man = byName.get(RIG2D.manifest);
    if (!man) return { ok: false, error: `${RIG2D.manifest} is missing.` };
    let json: unknown;
    try { json = JSON.parse(new TextDecoder().decode(await zipRead(bytes, man, inflateRaw, RIG2D_LIMITS.manifestBytes))); } catch (e) { return { ok: false, error: e instanceof ZipError ? e.message : `${RIG2D.manifest} is not valid JSON.` }; }
    const head = json as { magic?: unknown; version?: unknown };
    if (head?.magic !== RIG2D.magic) return { ok: false, error: `Not a ${RIG2D.name} manifest.` };
    if (typeof head.version === 'number' && head.version > RIG2D.version) return { ok: false, error: `This rig was made by a newer VTube Pro (format ${head.version}); update to open it.` };
    const raw = json as { buffers?: { file?: unknown }[] };
    const buffers: Uint8Array[] = [];
    let total = 0;
    for (const b of Array.isArray(raw.buffers) ? raw.buffers.slice(0, 256) : []) {
      const f = typeof b?.file === 'string' ? b.file : '';
      const e = f && SAFE_PATH.test(f) ? byName.get(f) : undefined;
      if (!e) return { ok: false, error: `Buffer ${String(f).slice(0, 60)} is missing.` };
      total += e.size;
      if (total > RIG2D_LIMITS.totalBytes) return { ok: false, error: 'The rig is too big.' };
      buffers.push(await zipRead(bytes, e, inflateRaw));
    }
    const v = validateRig2D(json, buffers.map((b) => b.length));
    if (!v.ok) return { ok: false, error: `The rig is not valid: ${v.issues[0].path}: ${v.issues[0].message}`, issues: v.issues };
    const files = new Map<string, Uint8Array>();
    const warnings: string[] = [];
    const want = new Set<string>();
    for (const t of v.doc.textures) for (const f of [t.file, t.normal, t.emission, t.rim]) if (f) want.add(f);
    want.add('thumb.png');
    for (const f of want) {
      if (!SAFE_PATH.test(f)) return { ok: false, error: `Unsafe file name ${f.slice(0, 60)}.` };
      const e = byName.get(f);
      if (!e) { if (f !== 'thumb.png') { if (v.doc.textures.some((t) => t.file === f)) return { ok: false, error: `Texture ${f.slice(0, 60)} is missing.` }; warnings.push(`${f} is missing.`); } continue; }
      files.set(f, await zipRead(bytes, e, inflateRaw, RIG2D_LIMITS.textureBytes));
    }
    return { ok: true, pkg: { doc: v.doc, buffers, files }, warnings };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------- buffer views
/** A typed array over a buffer view (copies when unaligned). */
export function viewArray(buffers: readonly Uint8Array[], v: BufferView): Float32Array | Int32Array | Uint32Array | Uint16Array | Int16Array | Uint8Array {
  const b = buffers[v.buffer];
  const C = { f32: Float32Array, i32: Int32Array, u32: Uint32Array, u16: Uint16Array, i16: Int16Array, u8: Uint8Array }[v.type];
  const start = b.byteOffset + v.offset;
  if (start % C.BYTES_PER_ELEMENT === 0) return new C(b.buffer as ArrayBuffer, start, v.count);
  const copy = b.slice(v.offset, v.offset + v.count * C.BYTES_PER_ELEMENT);
  return new C(copy.buffer, 0, v.count);
}
export const f32 = (buffers: readonly Uint8Array[], v: BufferView) => viewArray(buffers, v) as Float32Array;

/** Builds buffers for a writer: append typed arrays, get BufferViews back (4-byte aligned). */
export class BufferBuilder {
  private parts: Uint8Array[] = [];
  private size = 0;
  constructor(readonly index = 0) {}
  add(a: Float32Array | Int32Array | Uint32Array | Uint16Array | Int16Array | Uint8Array, type: BufferView['type']): BufferView {
    const pad = (4 - (this.size % 4)) % 4;
    if (pad) { this.parts.push(new Uint8Array(pad)); this.size += pad; }
    const off = this.size;
    const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength).slice();
    this.parts.push(bytes); this.size += bytes.length;
    return { buffer: this.index, offset: off, count: a.length, type };
  }
  f32(a: ArrayLike<number>) { return this.add(Float32Array.from(a), 'f32'); }
  bytes(): Uint8Array { const out = new Uint8Array(this.size); let o = 0; for (const p of this.parts) { out.set(p, o); o += p.length; } return out; }
}
