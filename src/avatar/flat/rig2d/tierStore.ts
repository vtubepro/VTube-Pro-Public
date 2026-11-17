// Where a page without VTube Pro's server (the browser-only mobile pack, src/mobile) keeps a 2D model's texture tiers: beside
// the model in this browser, vtp-web/avatars/<id>/gpu/<key>/… — the browser-side copy of the GPU tiers. Written through
// the browser store chain (src/mobile/webStore.ts: OPFS createWritable → OPFS through a worker's
// sync handle with an atomic temp + move → IndexedDB), so it works on every browser that keeps the model itself. When
// that store can't open (no storage at all), OPFS createWritable is tried once more. The cache is a convenience: when
// the browser evicts it, the next load draws the original pictures and makes it again.
import type { WebStore } from '../../../mobile/webStore.ts';

async function storeChain(): Promise<WebStore | null> {
  // (loaded on the first write only: pages that never build tiers never load the store)
  try { return await (await import('../../../mobile/webStore.ts')).webStore(); } catch { return null; }
}

async function opfsWrite(path: string[], data: Uint8Array) {
  let d = await navigator.storage.getDirectory();
  for (const p of path.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
  const fh = await d.getFileHandle(path[path.length - 1], { create: true });
  const w = await (fh as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
  await w.write(data.slice().buffer as ArrayBuffer); await w.close();
}

/** A writer for avatar `id`'s tier cache under key `key` (paths relative to the key folder). */
export function webTierWriter(id: string, key: string): (rel: string, bytes: Uint8Array) => Promise<void> {
  let st: Promise<WebStore | null> | null = null;
  return async (rel, bytes) => {
    const path = ['vtp-web', 'avatars', id, 'gpu', key, ...rel.split('/')];
    st ??= storeChain();
    const s = await st;
    if (s) await s.write(path, bytes);
    else await opfsWrite(path, bytes);
  };
}
