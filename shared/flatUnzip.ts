// Unpacking a 2D-avatar upload zip (POST /api/avatars/import-flat → server/flatImport.ts readFlatUpload). Real uploads
// are messy: the artist's whole Cubism project (multi-GB .psd / .cmo3 / videos next to the runtime folder), zips made on
// Japanese / Chinese / Korean Windows (file names in Shift-JIS / GBK / Big5 / EUC-KR without the UTF-8 flag), macOS
// zips (__MACOSX, NFD names), a zip inside the zip, password-protected or exotic packing methods. Untrusted input:
//   - ONE budget (files + unpacked bytes) covers the whole upload, zips inside the zip included: sizes come from the
//     directory and are charged BEFORE inflating, every entry inflates with a hard output cap (zlib maxOutputLength),
//     so an entry that lies about its size (a zip bomb) stops at once; an inner zip's own bytes and every file
//     unpacked from it are charged to the same budget; CRCs are checked;
//   - files a 2D avatar never needs (art sources, editor projects, video, audio) are skipped without inflating and
//     don't count toward the limits, so "I zipped the whole folder" just works;
//   - every problem is ONE plain sentence with what to do (FlatZipError.status = the HTTP status).
// The directory parsing is shared with the studio's repack (shared/zipDir.ts). Tests: tools/live2d_chaos_unit.ts,
// tools/flat_import_unit.ts, tools/mobile2d_unit.ts.
// Shared (the mobile2d lane moved it from server/): ONE implementation for the server and the browser's import worker
// (src/mobile/flatImport.worker.ts). Only inflating + the CRC differ: the helper plugs in Node's zlib
// (server/flatUnzip.ts); the default is fflate's streaming Inflate, stopped as soon as an entry inflates past its
// declared size (the same zip-bomb rule as zlib's maxOutputLength), with the shared CRC-32.
import { Inflate } from 'three/examples/jsm/libs/fflate.module.js';
import { importEntryCap } from './rig2d/limits.ts';
import { ZipDirError, chooseLegacyNames, crc32, keepForFlat, localHeaderLength, parseCentralDir, zip64End, zipEnd, zipExt, isZipJunk, type ZipDirEntry } from './zipDir.ts';

export { FLAT_SKIP_EXT, decodeZipName } from './zipDir.ts';

export class FlatZipError extends Error { constructor(readonly status: number, msg: string) { super(msg); } }

export interface FlatZipLimits { files: number; total: number; entry: number }
/** What is left of the upload's budget (shared by the zip and every zip inside it). */
interface Budget { files: number; bytes: number; lim: FlatZipLimits }

const DAMAGED = 'This .zip is damaged or cut off. Download it again, or unzip it and drop the folder.';
const BOMB = 'This .zip is damaged or unpacks to far more than it says (a “zip bomb”), so it was refused.';

/** How entries are inflated and checked. inflateRaw throws FlatZipError(413) when the data inflates past `size`;
 *  crc32 null = not checked. */
export interface UnzipIo { inflateRaw(raw: Uint8Array, size: number): Uint8Array; crc32(d: Uint8Array): number | null }
export const portableUnzipIo: UnzipIo = {
  inflateRaw(raw, size) {
    const out = new Uint8Array(size);
    let n = 0, over = false;
    const inf = new Inflate((chunk: Uint8Array) => { if (n + chunk.length > size) { over = true; throw new FlatZipError(413, BOMB); } out.set(chunk, n); n += chunk.length; });
    try {
      // small steps: deflate expands at most ~1032x, so one step never makes more than ~17 MB
      for (let i = 0; i < raw.length; i += 1 << 14) inf.push(raw.subarray(i, Math.min(raw.length, i + (1 << 14))), i + (1 << 14) >= raw.length);
      if (!raw.length) inf.push(new Uint8Array(0), true);
    } catch (e) { if (over || e instanceof FlatZipError) throw new FlatZipError(413, BOMB); throw new FlatZipError(400, DAMAGED); }
    return n === size ? out : out.subarray(0, n);
  },
  crc32: (d) => crc32(d),
};
let io: UnzipIo = portableUnzipIo;
/** The helper swaps in Node's zlib (server/flatUnzip.ts). */
export function setUnzipIo(x: UnzipIo) { io = x; }

/** Archives we can't open: one sentence instead of "not a zip". */
export function archiveProblem(b: Uint8Array): string | null {
  if (b.length >= 4 && b[0] === 0x52 && b[1] === 0x61 && b[2] === 0x72 && b[3] === 0x21) return 'This is a RAR archive. Unpack it first (right-click → Extract, or 7-Zip), then drop the model folder, or zip it with Windows (right-click → Send to → Compressed folder).';
  if (b.length >= 4 && b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc && b[3] === 0xaf) return 'This is a 7-Zip archive. Unpack it first (7-Zip → Extract here), then drop the model folder, or zip it with Windows (right-click → Send to → Compressed folder).';
  if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) return 'This is a .gz / .tar.gz archive. Unpack it first, then drop the model folder.';
  if (b.length >= 6 && b[0] === 0x4c && b[1] === 0x5a && b[2] === 0x49 && b[3] === 0x50) return 'This is an .lz archive. Unpack it first, then drop the model folder.';
  return null;
}

/** The central directory (no inflating). */
export function listZip(b: Uint8Array, maxEntries = 65535): ZipDirEntry[] {
  try {
    let { count, cdOff, cdSize, zip64At } = zipEnd(b, 0);
    if (zip64At !== null) { if (zip64At + 56 > b.length) throw new ZipDirError('damaged'); ({ count, cdOff, cdSize } = zip64End(b.subarray(zip64At, zip64At + 56))); }
    if (cdOff > b.length || cdOff + cdSize > b.length) throw new ZipDirError('damaged');
    return parseCentralDir(b.subarray(cdOff, cdOff + cdSize), count, maxEntries);
  } catch (e) {
    if (e instanceof ZipDirError && e.kind === 'too-many') throw new FlatZipError(413, 'This .zip has too many files in it. Zip just the model folder (the one with the .model3.json) and drop that.');
    throw new FlatZipError(400, DAMAGED);
  }
}

function entryBytes(b: Uint8Array, e: ZipDirEntry, lim: FlatZipLimits): Uint8Array {
  if (e.local + 30 > b.length) throw new FlatZipError(400, DAMAGED);
  let start: number;
  try { start = e.local + localHeaderLength(b.subarray(e.local, e.local + 30)); } catch { throw new FlatZipError(400, DAMAGED); }
  if (start + e.csize > b.length) throw new FlatZipError(400, DAMAGED);
  let out: Uint8Array;
  if (e.method === 0) {
    // stored: the directory's two sizes must agree (and fit the limits) before anything is copied
    if (e.csize !== e.size || e.size > lim.entry) throw new FlatZipError(400, DAMAGED);
    out = b.slice(start, start + e.csize);
  } else if (e.method === 8) {
    out = io.inflateRaw(b.subarray(start, start + e.csize), Math.max(0, e.size));
  } else throw new FlatZipError(422, 'This .zip was packed with a method VTube Pro can’t read. Unzip it, then zip the model folder again with Windows (right-click → Send to → Compressed folder) or drop the folder itself.');
  if (out.length !== e.size) throw new FlatZipError(400, DAMAGED);
  const crc = io.crc32(out);
  if (crc !== null && crc !== e.crc) throw new FlatZipError(400, 'A file in this .zip is damaged. Download it again, or unzip it and drop the folder.');
  return out;
}

const looksLikeModel = (p: string) => /\.(model3\.json|model\.json|moc3|vtp2|inp|inx|png|apng|gif|webp|jpe?g)$/i.test(p) || /(^|\/)rig\.json$/.test(p);
const tooBig = (lim: FlatZipLimits) => new FlatZipError(413, `The zip is too big unpacked (at most ${lim.total >> 20} MB, ${lim.files} files). Zip just the model folder and drop that.`);
/** Charge a file to the shared budget (before it is inflated). */
function charge(B: Budget, size: number, maxEntry = B.lim.entry) {
  B.files--; B.bytes -= size;
  if (B.files < 0 || B.bytes < 0 || size > maxEntry) throw tooBig(B.lim);
}

/** A zip upload as path → bytes: junk and never-needed files skipped (not inflated, not counted), the budget enforced
 *  from the directory before inflating, a zip inside the zip opened when the outer one holds no model. */
export function readFlatZip(body: Uint8Array, lim: FlatZipLimits, depth = 0, skipped: string[] = [], budget?: Budget): Map<string, Uint8Array> {
  const B: Budget = budget ?? { files: lim.files, bytes: lim.total, lim };
  const all = listZip(body);
  const keep: ZipDirEntry[] = [], inner: ZipDirEntry[] = [];
  for (const e of all) {
    if (e.name.endsWith('/') || isZipJunk(e.name)) continue;
    if (zipExt(e.name) === 'zip') { inner.push(e); continue; }
    if (!keepForFlat(e.name)) { if (skipped.length < 64) skipped.push(e.name); continue; }
    keep.push(e);
    charge(B, e.size);
  }
  const out = new Map<string, Uint8Array>();
  if (keep.some((e) => e.flags & 1)) throw new FlatZipError(422, 'This .zip is password-protected. Unzip it yourself (it asks for the password), then drop the folder.');
  for (const e of keep) out.set(e.name, entryBytes(body, e, lim));
  // names in a guessed code page: pick the code page under which the model's own JSON finds its files
  chooseLegacyNames(keep, out);
  // a zip inside the zip (the artist's delivery zip around the model zip): open it when nothing usable is outside it
  if (depth === 0 && inner.length && ![...out.keys()].some((p) => looksLikeModel(p) && !/(^|\/)(icon|thumb|preview|vtubeicon)[^/]*$/i.test(p))) {
    for (const e of inner.slice(0, 8)) {
      if (e.flags & 1) throw new FlatZipError(422, 'The .zip inside this .zip is password-protected. Unzip it yourself (it asks for the password), then drop the folder.');
      // the inner archive itself is held in memory while it is read: charged like a file, and given back after
      charge(B, e.size, importEntryCap(e.name));
      const ib = entryBytes(body, e, { ...lim, entry: lim.total });
      const stem = e.name.replace(/\.zip$/i, '');
      let got: Map<string, Uint8Array>;
      try { got = readFlatZip(ib, lim, depth + 1, skipped, B); }
      catch (x) { if (x instanceof FlatZipError && x.status === 413) throw x; B.files++; B.bytes += e.size; continue; }
      B.files++; B.bytes += e.size;
      for (const [k, v] of got) out.set(`${stem}/${k}`, v);
    }
  }
  return out;
}

// ---------------------------------------------------------------- the same reader over a Blob (the browser)
// A picked File stays on the phone's disk: only the zip's directory and the KEPT entries are read, each in its own
// slice, so the whole upload is never in memory (src/mobile/flatImport.worker.ts). Same rules as readFlatZip: junk and
// art sources skipped unread, one budget charged from the directory before inflating, zip bombs stopped, CRCs checked,
// a zip inside the zip opened when the outer one holds no model.
const readSlice = async (f: Blob, at: number, n: number) => new Uint8Array(await f.slice(at, at + n).arrayBuffer());

/** The kept files' unpacked total, from the directory alone (no inflating). A zip inside the zip is NOT counted here:
 *  like readFlatZip, it is charged only when it is opened (when the outer zip holds no model). */
function keptTotal(all: ZipDirEntry[]): number {
  let n = 0;
  for (const e of all) if (!e.name.endsWith('/') && !isZipJunk(e.name) && zipExt(e.name) !== 'zip' && keepForFlat(e.name)) n += e.size;
  return n;
}
/** The zip's directory read from the end of a Blob. */
async function listZipBlob(f: Blob, maxEntries = 65535): Promise<ZipDirEntry[]> {
  try {
    const tailLen = Math.min(f.size, 22 + 65535 + 20);
    const tail = await readSlice(f, f.size - tailLen, tailLen);
    let { count, cdOff, cdSize, zip64At } = zipEnd(tail, f.size - tailLen);
    if (zip64At !== null) { if (zip64At + 56 > f.size) throw new ZipDirError('damaged'); ({ count, cdOff, cdSize } = zip64End(await readSlice(f, zip64At, 56))); }
    if (cdOff > f.size || cdOff + cdSize > f.size) throw new ZipDirError('damaged');
    return parseCentralDir(await readSlice(f, cdOff, cdSize), count, maxEntries);
  } catch (e) {
    if (e instanceof ZipDirError && e.kind === 'too-many') throw new FlatZipError(413, 'This .zip has too many files in it. Zip just the model folder (the one with the .model3.json) and drop that.');
    throw new FlatZipError(400, DAMAGED);
  }
}
/** One entry's bytes, reading only its own slice of the Blob. */
async function entryBytesBlob(f: Blob, e: ZipDirEntry, lim: FlatZipLimits): Promise<Uint8Array> {
  if (e.local + 30 > f.size) throw new FlatZipError(400, DAMAGED);
  let hl: number;
  try { hl = localHeaderLength(await readSlice(f, e.local, 30)); } catch { throw new FlatZipError(400, DAMAGED); }
  const buf = await readSlice(f, e.local, hl + e.csize);
  return entryBytes(buf, { ...e, local: 0 }, lim);
}
/** The too-big sentence with both sizes (the studio words it for a phone: src/mobile/flatImportWeb.ts phoneWords). */
export const tooBigUnpacked = (bytes: number, lim: FlatZipLimits) => new FlatZipError(413, `This model is ${Math.ceil(bytes / 1048576)} MB unpacked; at most ${lim.total >> 20} MB can be imported here. Zip just the model folder (the one with the .model3.json) and drop that.`);

/** readFlatZip over a Blob (see above). */
export async function readFlatZipBlob(f: Blob, lim: FlatZipLimits, skipped: string[] = []): Promise<Map<string, Uint8Array>> {
  const B: Budget = { files: lim.files, bytes: lim.total, lim };
  const all = await listZipBlob(f);
  const total = keptTotal(all);
  if (total > lim.total) throw tooBigUnpacked(total, lim);
  const keep: ZipDirEntry[] = [], inner: ZipDirEntry[] = [];
  for (const e of all) {
    if (e.name.endsWith('/') || isZipJunk(e.name)) continue;
    if (zipExt(e.name) === 'zip') { inner.push(e); continue; }
    if (!keepForFlat(e.name)) { if (skipped.length < 64) skipped.push(e.name); continue; }
    keep.push(e);
    charge(B, e.size);
  }
  const out = new Map<string, Uint8Array>();
  if (keep.some((e) => e.flags & 1)) throw new FlatZipError(422, 'This .zip is password-protected. Unzip it yourself (it asks for the password), then drop the folder.');
  for (const e of keep) out.set(e.name, await entryBytesBlob(f, e, lim));
  chooseLegacyNames(keep, out);
  if (inner.length && ![...out.keys()].some((p) => looksLikeModel(p) && !/(^|\/)(icon|thumb|preview|vtubeicon)[^/]*$/i.test(p))) {
    for (const e of inner.slice(0, 8)) {
      if (e.flags & 1) throw new FlatZipError(422, 'The .zip inside this .zip is password-protected. Unzip it yourself (it asks for the password), then drop the folder.');
      charge(B, e.size, importEntryCap(e.name));
      const ib = await entryBytesBlob(f, e, { ...lim, entry: lim.total });
      const stem = e.name.replace(/\.zip$/i, '');
      let got: Map<string, Uint8Array>;
      try { got = readFlatZip(ib, lim, 1, skipped, B); }
      catch (x) { if (x instanceof FlatZipError && x.status === 413) throw x; B.files++; B.bytes += e.size; continue; }
      B.files++; B.bytes += e.size;
      for (const [k, v] of got) out.set(`${stem}/${k}`, v);
    }
  }
  return out;
}
