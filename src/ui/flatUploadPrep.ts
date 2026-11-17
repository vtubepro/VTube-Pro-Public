// What the studio sends to the 2D importer (POST /api/avatars/import-flat, at most IMPORT_LIMITS.uploadBytes): people
// drop the artist's whole delivery: the Live2D runtime folder next to multi-hundred-MB .psd / .cmo3 / video files.
// Those are never part of a 2D avatar, so they stay home: a dropped folder is zipped without them, and a zip over the
// limit is repacked without them in a worker (src/ui/flatPrune.ts: reads only the directory and the kept entries,
// inflates against a hard budget). The helper skips them too (server/flatUnzip.ts): this only keeps big uploads
// under the limit. Limits: shared/rig2d/limits.ts.
import { keepForFlat } from '../../shared/zipDir.ts';
import { IMPORT_LIMITS } from '../../shared/rig2d/limits.ts';

/** A file a 2D avatar never needs (art sources, editor projects, video / audio, OS junk). */
export const skipForFlat = (name: string) => !keepForFlat(name.replace(/^\/+/, ''));
export const FLAT_UPLOAD_LIMIT = IMPORT_LIMITS.unpackedBytes;

/** A zip over the upload limit, repacked (in a worker) without the files a 2D avatar never needs; null = send it as it
 *  is. Throws one plain sentence when that can't be done. */
export async function pruneBigZip(f: File): Promise<Blob | null> {
  if (f.size <= FLAT_UPLOAD_LIMIT || !/\.zip$/i.test(f.name)) return null;
  const w = new Worker(new URL('./flatPruneWorker.ts', import.meta.url), { type: 'module' });
  try {
    const r = await new Promise<{ ok: boolean; bytes?: Uint8Array; error?: string }>((res) => {
      w.onmessage = (e) => res(e.data);
      w.onerror = () => res({ ok: false, error: 'The studio couldn’t open this .zip. Unzip it and drop the model folder instead.' });
      w.postMessage({ file: f });
    });
    if (!r.ok || !r.bytes) throw new Error(r.error ?? 'The studio couldn’t open this .zip. Unzip it and drop the model folder instead.');
    return new Blob([r.bytes.buffer as ArrayBuffer], { type: 'application/zip' });
  } finally { w.terminate(); }
}

/** The upload as it will be sent: one plain sentence when it is still over the helper's limit. */
export function checkFlatUploadSize(b: Blob) {
  if (b.size > IMPORT_LIMITS.uploadBytes) throw new Error(`That is ${Math.round(b.size / 1048576)} MB, more than the ${IMPORT_LIMITS.uploadBytes >> 20} MB a 2D avatar upload can be. Zip just the model folder (the one with the .model3.json) or your pictures, and drop that.`);
}
