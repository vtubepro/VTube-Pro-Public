// Repack a big delivery zip without the files a 2D avatar never needs (art sources, editor projects, video …), read
// from the File in slices: only the zip's directory and the kept entries are ever read, never the whole file, and every
// kept entry inflates in small steps against a hard budget (its declared size, the upload's unpacked total, the file
// count), so a zip bomb stops within a few MB. Pure (Blob + fflate): runs in a worker in the studio
// (src/ui/flatPruneWorker.ts) and in Node in tests (tools/live2d_chaos_unit.ts).
import { Inflate, zipSync } from 'three/examples/jsm/libs/fflate.module.js';
import { ZipDirError, chooseLegacyNames, crc32, keepForFlat, localHeaderLength, parseCentralDir, zip64End, zipEnd, type ZipDirEntry } from '../../shared/zipDir.ts';
import { IMPORT_LIMITS, importEntryCap } from '../../shared/rig2d/limits.ts';

export class PruneError extends Error {}
export interface PruneBudget { files: number; bytes: number; entry: number }
/** `entry` = the per-file cap for pictures / .moc3 / JSON; a zip inside the delivery may use the whole budget
 *  (importEntryCap, shared/rig2d/limits.ts) */
export const PRUNE_BUDGET: PruneBudget = { files: IMPORT_LIMITS.files * 2, bytes: IMPORT_LIMITS.unpackedBytes, entry: IMPORT_LIMITS.entryBytes };

const DAMAGED = 'This .zip is damaged or uses a packing method the studio can’t open. Unzip it and drop the model folder instead.';
const TOO_BIG = 'This zip is over 300 MB even without the art files. Zip just the model folder (the one with the .model3.json) and drop that.';
const read = async (f: Blob, at: number, n: number) => new Uint8Array(await f.slice(at, at + n).arrayBuffer());
/** compressed bytes per inflate step: deflate expands at most ~1032×, so one step never makes more than ~17 MB */
const STEP = 16 << 10;

const tooBigFile = (e: ZipDirEntry, max: number) => new PruneError(`${e.name.split('/').pop()} in this zip unpacks to ${Math.ceil(e.size / 1048576)} MB, more than the ${max >> 20} MB it can be. Zip just the model folder (the one with the .model3.json) and drop that.`);
/** Inflate (or copy) one entry, never producing more than `max` bytes; its CRC must match. */
async function entryData(f: Blob, e: ZipDirEntry, max: number): Promise<Uint8Array> {
  if (e.size > max) throw tooBigFile(e, max);
  const h = await read(f, e.local, 30);
  let start: number;
  try { start = e.local + localHeaderLength(h); } catch { throw new PruneError(DAMAGED); }
  if (start + e.csize > f.size) throw new PruneError(DAMAGED);
  if (e.method === 0) {
    if (e.csize !== e.size) throw new PruneError(DAMAGED);
    const raw = await read(f, start, e.csize);
    if (crc32(raw) !== e.crc) throw new PruneError(DAMAGED);
    return raw;
  }
  if (e.method !== 8) throw new PruneError(DAMAGED);
  const out = new Uint8Array(e.size);
  let n = 0, over = false;
  const inf = new Inflate((chunk: Uint8Array) => {
    if (n + chunk.length > e.size) { over = true; return; }
    out.set(chunk, n); n += chunk.length;
  });
  for (let at = 0; at < e.csize && !over;) {
    const part = await read(f, start + at, Math.min(1 << 20, e.csize - at));
    for (let q = 0; q < part.length && !over; q += STEP) {
      const last = at + q + STEP >= e.csize;
      try { inf.push(part.subarray(q, Math.min(part.length, q + STEP)), last); } catch { throw new PruneError(DAMAGED); }
    }
    at += part.length;
  }
  if (over) throw new PruneError('This .zip unpacks to far more than it says (a “zip bomb”), so it was not sent.');
  if (n !== e.size || crc32(out) !== e.crc) throw new PruneError(DAMAGED);
  return out;
}

/** The zip again, without what a 2D avatar never needs; the kept entries charged against `budget` while inflating. */
export async function pruneZipBlob(f: Blob, budget: PruneBudget = PRUNE_BUDGET): Promise<Uint8Array> {
  let entries: ZipDirEntry[];
  try {
    const tailN = Math.min(f.size, 65557 + 20);
    const tail = await read(f, f.size - tailN, tailN);
    let { count, cdOff, cdSize, zip64At } = zipEnd(tail, f.size - tailN);
    if (zip64At !== null) ({ count, cdOff, cdSize } = zip64End(await read(f, zip64At, 56)));
    if (cdOff + cdSize > f.size || cdSize > 64 << 20) throw new ZipDirError('damaged');
    entries = parseCentralDir(await read(f, cdOff, cdSize), count);
  } catch (e) { throw new PruneError(e instanceof ZipDirError && e.kind === 'too-many' ? TOO_BIG : DAMAGED); }
  const keep = entries.filter((e) => keepForFlat(e.name));
  if (keep.some((e) => e.flags & 1)) throw new PruneError('This .zip is password-protected. Unzip it yourself (it asks for the password), then drop the folder.');
  let files = budget.files, bytes = budget.bytes;
  const out = new Map<string, Uint8Array>();
  for (const e of keep) {
    files--; bytes -= e.size;
    if (files < 0 || bytes < 0) throw new PruneError(TOO_BIG);
    // per kind: a picture / .moc3 / JSON at most the per-file cap, a zip inside the delivery the remaining budget
    const cap = /\.zip$/i.test(e.name) ? importEntryCap(e.name) : budget.entry;
    if (e.size > cap) throw tooBigFile(e, cap);
    out.set(e.name, await entryData(f, e, Math.min(cap, bytes + e.size)));
  }
  chooseLegacyNames(keep, out);
  return zipSync(Object.fromEntries([...out].map(([k, v]) => [k, [v, { level: 0 }]])) as never);
}
