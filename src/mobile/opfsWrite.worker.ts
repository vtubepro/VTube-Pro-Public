// OPFS writes for browsers without FileSystemFileHandle.createWritable (Safari before 26): a dedicated worker's
// createSyncAccessHandle (src/mobile/webStore.ts). One message = one whole file, written ATOMICALLY:
//   1. the bytes go to "<name>.tmp~" (the live file is never truncated or touched), read from the Blob in 4 MB slices
//      (a big model is never held in memory whole), then flushed and closed;
//   2. the finished temp file is moved onto the name (FileSystemHandle.move). Where move won't replace an existing
//      file, the old name is removed only now, after the temp file is complete, then the move is made; a crash between
//      the two leaves the complete temp file, which webStore's read uses when the name is missing.
// A failure (quota, a crash, a kill) before step 2 leaves the old file exactly as it was; the temp file is removed.
// `test` (tools/mobile2d_e2e.mjs only, through webStore's test hook): 'stall' = stop forever after the first slice
// (the page then kills this worker, like iOS killing a tab mid-save); 'quota' = fail like a full disk after it;
// 'retryThrows' = Safari's "name exists", then the second move fails too.
interface SyncHandle { truncate(n: number): void; write(b: ArrayBufferView | ArrayBuffer, o?: { at: number }): number; flush(): void; close(): void }
type Movable = FileSystemFileHandle & { move?(dir: FileSystemDirectoryHandle, name: string): Promise<void>; createSyncAccessHandle(): Promise<SyncHandle> };
const TMP = '.tmp~'; // (src/mobile/webStore.ts has the same suffix)
const SLICE = 4 << 20;

self.onmessage = async (e: MessageEvent<{ id: number; path: string[]; blob: Blob; test?: 'stall' | 'quota' | 'retryThrows' }>) => {
  const { id, path, blob, test } = e.data;
  const name = path[path.length - 1];
  let dir: FileSystemDirectoryHandle | null = null;
  let h: SyncHandle | null = null;
  let tmpMade = false;
  /** the old file was removed for the move: the complete temp file is now the only copy */
  let liveGone = false;
  try {
    dir = await navigator.storage.getDirectory();
    for (const p of path.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
    const tmp = await dir.getFileHandle(name + TMP, { create: true }) as Movable;
    tmpMade = true;
    if (typeof tmp.move !== 'function') throw Object.assign(new Error('no atomic move here'), { name: 'NotSupportedError' });
    h = await tmp.createSyncAccessHandle();
    h.truncate(0);
    let at = 0;
    for (let off = 0; off < blob.size; off += SLICE) {
      const u8 = new Uint8Array(await blob.slice(off, Math.min(blob.size, off + SLICE)).arrayBuffer());
      let done = 0;
      while (done < u8.length) done += h.write(u8.subarray(done), { at: at + done });
      at += u8.length;
      if (test === 'stall') await new Promise(() => { /* the page kills the worker now */ });
      if (test === 'quota') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    }
    h.flush(); h.close(); h = null;
    // 2. the complete temp file takes the name. Only when move refuses because the name exists
    // (InvalidModificationError: Safari never replaces) is the old file removed, and only now that the temp is complete;
    // from then on the temp is the ONLY copy: it is never deleted (a read uses it while the name is missing, and the
    // store's start-up sweep moves it onto the name)
    try {
      if (test === 'retryThrows') throw new DOMException('the name exists', 'InvalidModificationError');
      await tmp.move!(dir, name);
    } catch (e) {
      if ((e as DOMException)?.name !== 'InvalidModificationError') throw e;
      try { await dir.removeEntry(name); } catch { /* there was no old file */ }
      liveGone = true;
      if (test === 'retryThrows') throw new DOMException('the move failed (test)', 'UnknownError');
      await tmp.move!(dir, name);
    }
    (self as unknown as Worker).postMessage({ id });
  } catch (err) {
    try { h?.close(); } catch { /* closed */ }
    if (tmpMade && dir && !liveGone) { try { await dir.removeEntry(name + TMP); } catch { /* best effort */ } }
    const n = (err as DOMException)?.name;
    (self as unknown as Worker).postMessage({ id, error: String((err as Error)?.message ?? err), full: n === 'QuotaExceededError', unsupported: n === 'NotSupportedError' });
  }
};
