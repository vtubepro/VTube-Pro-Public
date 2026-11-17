// Worker: repack a big delivery zip off the studio's main thread (src/ui/flatPrune.ts), so the UI never freezes.
import { PruneError, pruneZipBlob } from './flatPrune.ts';

self.onmessage = async (e: MessageEvent<{ file: Blob }>) => {
  try {
    const z = await pruneZipBlob(e.data.file);
    (self as unknown as Worker).postMessage({ ok: true, bytes: z }, [z.buffer]);
  } catch (x) {
    (self as unknown as Worker).postMessage({ ok: false, error: x instanceof PruneError ? x.message : 'This .zip is damaged or uses a packing method the studio can’t open. Unzip it and drop the model folder instead.' });
  }
};
