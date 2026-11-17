// Where the browser-only mode (no server) keeps the user's own models and rooms, on every browser that can keep anything:
//   1. OPFS + FileSystemFileHandle.createWritable()            (Chrome, Edge, Firefox, Safari 26+)
//   2. OPFS + a worker's createSyncAccessHandle()               (Safari 15.2-18.x on iPhone / iPad / Mac: OPFS, no
//                                                                createWritable on the main thread or in workers)
//   3. IndexedDB, one Blob per file                             (no OPFS at all, or OPFS refuses writes)
// Picked ONCE per page by a real write probe, so reads and writes always go to the same place. Paths are folder lists
// under the OPFS root (['vtp-web', 'avatars', id, 'profile.json']). Every failure is a plain sentence (WebStoreError).
// The store is also what makes iOS 18 work at all: before this, every web-mode save answered "createWritable is not a
// function".
export type StoreKind = 'opfs' | 'opfs-worker' | 'idb';
export class WebStoreError extends Error { constructor(msg: string, readonly full = false) { super(msg); } }

const FULL = 'Your phone or browser is out of space for models. Remove a model you don’t use, then try again.';
const NOPE = 'This browser won’t let VTube Pro save files (a private window?). Use a normal browser window and try again.';
const isFull = (e: unknown) => (e as DOMException)?.name === 'QuotaExceededError' || /quota|space/i.test(String((e as Error)?.message ?? ''));

export interface Entry { name: string; kind: 'file' | 'directory' }
export interface WebStore {
  readonly kind: StoreKind;
  write(path: string[], data: Blob | string | Uint8Array): Promise<void>;
  read(path: string[]): Promise<Blob | null>;
  /** read, but null ONLY when the file does not exist; any failure throws (the "Edit rig" journal must never take an
   *  unreadable file for a missing one: src/net/webRigEdit.ts) */
  readStrict(path: string[]): Promise<Blob | null>;
  list(dir: string[]): Promise<Entry[]>;
  remove(path: string[]): Promise<void>;
}

// (a Uint8Array goes into the Blob as it is: the Blob keeps its own copy, no second copy here)
const toBlob = (d: Blob | string | Uint8Array) => d instanceof Blob ? d : typeof d === 'string' ? new Blob([d], { type: 'application/json' }) : new Blob([d as Uint8Array<ArrayBuffer>]);

// ---------------------------------------------------------------- OPFS
async function opfsDir(path: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
  let d = await navigator.storage.getDirectory();
  for (const p of path) d = await d.getDirectoryHandle(p, { create });
  return d;
}
type Writer = (path: string[], b: Blob) => Promise<void>;
const writableWriter: Writer = async (path, b) => {
  const d = await opfsDir(path.slice(0, -1), true);
  const fh = await d.getFileHandle(path[path.length - 1], { create: true });
  const w = await (fh as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
  await w.write(b); await w.close();
};
/** The worker path's temp-file suffix (src/mobile/opfsWrite.worker.ts): never listed; a complete one stands in for a
 *  name a crash removed between "remove old" and "move". */
const TMP = '.tmp~';
let worker: Worker | null = null; let seq = 0;
const pending = new Map<number, { ok: () => void; no: (e: Error) => void }>();
/** tests only (tools/mobile2d_e2e.mjs through window.__vtpStoreTest): the next worker write stalls or fails on quota */
let nextTest: 'stall' | 'quota' | 'retryThrows' | null = null;
function killWorker(why: string) { worker?.terminate(); worker = null; for (const p of pending.values()) p.no(new Error(why)); pending.clear(); }
function workerWriter(): Writer {
  return async (path, b) => {
    if (!worker) {
      worker = new Worker(new URL('./opfsWrite.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<{ id: number; error?: string; full?: boolean }>) => {
        const p = pending.get(e.data.id); if (!p) return; pending.delete(e.data.id);
        if (e.data.error) p.no(Object.assign(new Error(e.data.error), { name: e.data.full ? 'QuotaExceededError' : 'Error' })); else p.ok();
      };
      worker.onerror = () => killWorker('the save worker stopped');
    }
    const id = ++seq;
    const test = nextTest; nextTest = null;
    // the Blob itself goes over (the worker reads it in slices: a big model is never copied into memory whole)
    await new Promise<void>((ok, no) => { pending.set(id, { ok, no }); worker!.postMessage({ id, path, blob: b, ...(test ? { test } : {}) }); });
  };
}
function opfsStore(kind: 'opfs' | 'opfs-worker', write: Writer): WebStore {
  return {
    kind,
    async write(path, data) { try { await write(path, toBlob(data)); } catch (e) { console.info(`[web store] ${kind} write: ${(e as Error)?.name} ${(e as Error)?.message}`); throw new WebStoreError(isFull(e) ? FULL : NOPE, isFull(e)); } },
    async read(path) {
      try {
        const d = await opfsDir(path.slice(0, -1), false), name = path[path.length - 1];
        try { return await (await d.getFileHandle(name)).getFile(); }
        catch { return await (await d.getFileHandle(name + TMP)).getFile(); }   // (see TMP)
      } catch { return null; }
    },
    async readStrict(path) {
      const missing = (e: unknown) => (e as DOMException)?.name === 'NotFoundError';
      let d: FileSystemDirectoryHandle;
      try { d = await opfsDir(path.slice(0, -1), false); } catch (e) { if (missing(e)) return null; throw e; }
      const name = path[path.length - 1];
      try { return await (await d.getFileHandle(name)).getFile(); } catch (e) { if (!missing(e)) throw e; }
      try { return await (await d.getFileHandle(name + TMP)).getFile(); } catch (e) { if (missing(e)) return null; throw e; }   // (see TMP)
    },
    async list(dir) {
      try {
        const d = await opfsDir(dir, false); const out = new Map<string, Entry>();
        for await (const h of (d as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
          const name = h.name.endsWith(TMP) ? h.name.slice(0, -TMP.length) : h.name;
          if (!out.has(name)) out.set(name, { name, kind: h.kind });
        }
        return [...out.values()];
      } catch { return []; }
    },
    async remove(path) {
      try {
        const d = await opfsDir(path.slice(0, -1), false), name = path[path.length - 1];
        for (const n of [name, name + TMP]) { try { await d.removeEntry(n, { recursive: true }); } catch { /* not there */ } }
      } catch { /* gone already */ }
    },
  };
}

// ---------------------------------------------------------------- IndexedDB
const DB = 'vtp-web-files', OS = 'files';
let dbP: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbP ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(OS);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error ?? new Error('IndexedDB refused'));
  });
  return dbP;
}
const req = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const k = (path: string[]) => path.join('/');
function idbStore(): WebStore {
  const tx = async (mode: IDBTransactionMode) => (await db()).transaction(OS, mode).objectStore(OS);
  return {
    kind: 'idb',
    async write(path, data) {
      try {
        // Safari stores Blobs in IndexedDB since iOS 14; an ArrayBuffer is the safe form everywhere
        const b = toBlob(data); const v = { type: b.type, buf: await b.arrayBuffer() };
        await req((await tx('readwrite')).put(v, k(path)));
      } catch (e) { throw new WebStoreError(isFull(e) ? FULL : NOPE, isFull(e)); }
    },
    async read(path) {
      try { const v = await req((await tx('readonly')).get(k(path))) as { type: string; buf: ArrayBuffer } | undefined; return v ? new Blob([v.buf], { type: v.type }) : null; } catch { return null; }
    },
    async readStrict(path) {
      const v = await req((await tx('readonly')).get(k(path))) as { type: string; buf: ArrayBuffer } | undefined;
      return v ? new Blob([v.buf], { type: v.type }) : null;
    },
    async list(dir) {
      try {
        const pre = k(dir) + '/';
        const keys = await req((await tx('readonly')).getAllKeys(IDBKeyRange.bound(pre, pre + '￿'))) as string[];
        const out = new Map<string, Entry>();
        for (const key of keys) { const rest = key.slice(pre.length); const i = rest.indexOf('/'); const name = i < 0 ? rest : rest.slice(0, i); if (!out.has(name)) out.set(name, { name, kind: i < 0 ? 'file' : 'directory' }); }
        return [...out.values()];
      } catch { return []; }
    },
    async remove(path) {
      try {
        // both deletes queued on ONE transaction before anything is awaited (an await in between commits it: the
        // folder's files then stayed)
        const t = (await db()).transaction(OS, 'readwrite'), os = t.objectStore(OS), key = k(path);
        os.delete(key);
        os.delete(IDBKeyRange.bound(key + '/', key + '/￿'));
        await new Promise<void>((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
      } catch { /* best effort */ }
    },
  };
}

// ---------------------------------------------------------------- pick one, by a real write
const PROBE = ['vtp-web', '.probe'];
let storeP: Promise<WebStore | null> | null = null;
/** Test hook (tools/mobile2d_e2e.mjs): localStorage vtp.store = 'opfs' | 'opfs-worker' | 'idb' forces a backend. */
function forced(): StoreKind | null { try { const v = localStorage.getItem('vtp.store'); return v === 'opfs' || v === 'opfs-worker' || v === 'idb' ? v : null; } catch { return null; } }
async function works(s: WebStore): Promise<boolean> {
  try {
    // (read the text BEFORE removing: an OPFS File can't be read once its entry is gone)
    await s.write(PROBE, 'ok'); const b = await s.read(PROBE); const text = b ? await b.text() : null; await s.remove(PROBE);
    const good = text === 'ok';
    if (!good) console.info(`[web store] ${s.kind}: the test file didn't read back`);
    return good;
  } catch (e) { console.info(`[web store] ${s.kind} can't save here: ${(e as Error)?.message ?? e}`); return false; }
}
export function webStore(): Promise<WebStore | null> {
  storeP ??= (async () => {
    const want = forced();
    const hasOpfs = typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;
    const hasWritable = typeof FileSystemFileHandle !== 'undefined' && 'createWritable' in FileSystemFileHandle.prototype;
    const order: (() => WebStore)[] = [];
    if (hasOpfs && hasWritable && (!want || want === 'opfs')) order.push(() => opfsStore('opfs', writableWriter));
    if (hasOpfs && typeof Worker !== 'undefined' && (!want || want === 'opfs-worker')) order.push(() => opfsStore('opfs-worker', workerWriter()));
    if (typeof indexedDB !== 'undefined' && (!want || want === 'idb')) order.push(idbStore);
    let chosen: WebStore | null = null;
    for (const make of order) { const s = make(); if (await works(s)) { chosen = s; break; } }
    if (!chosen) return null;
    console.info(`[web store] ${chosen.kind}`);
    // a save that was cut off leaves "<name>.tmp~" files: tidy them before anything is read
    if (chosen.kind !== 'idb') { try { await sweepTemps(chosen); } catch (e) { console.info(`[web store] tidying temp files failed: ${(e as Error)?.message}`); } }
    // models saved earlier in another place of this browser (OPFS before a probe failed, or IndexedDB) are never lost:
    // they are moved over (copied, checked, then removed from the old place), and a move cut short goes on next time
    try { await adopt(chosen, hasOpfs); } catch (e) { console.info(`[web store] moving older models over stopped: ${(e as Error)?.message}`); }
    return chosen;
  })();
  return storeP;
}

/** The start-up sweep (OPFS stores): a "<name>.tmp~" next to its live name is a save that never finished (removed);
 *  one whose live name is gone is a save that finished but wasn't moved yet (it becomes the name). */
let swept = 0;
async function sweepTemps(st: WebStore) {
  let root: FileSystemDirectoryHandle;
  try { root = await opfsDir(['vtp-web'], false); } catch { return; }
  const walk = async (d: FileSystemDirectoryHandle, path: string[], depth: number): Promise<void> => {
    const names = new Map<string, FileSystemHandle>();
    for await (const h of (d as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) names.set(h.name, h);
    for (const [n, h] of names) {
      if (h.kind === 'directory') { if (depth < 8) await walk(h as FileSystemDirectoryHandle, [...path, n], depth + 1); continue; }
      if (!n.endsWith(TMP)) continue;
      const live = n.slice(0, -TMP.length);
      if (names.has(live)) { await d.removeEntry(n); swept++; continue; }
      const fh = h as FileSystemFileHandle & { move?(dir: FileSystemDirectoryHandle, name: string): Promise<void> };
      if (typeof fh.move === 'function') { try { await fh.move(d, live); swept++; continue; } catch { /* copy below */ } }
      await st.write([...path, live], await fh.getFile());
      await d.removeEntry(n).catch(() => {});
      swept++;
    }
  };
  await walk(root, ['vtp-web'], 0);
  if (swept) console.info(`[web store] tidied ${swept} temp files`);
}

/** What adopt() moved (tests: window.__vtpStoreTest.adopted / moved). */
let adopted = 0, movedIds = 0;
/** Move vtp-web/avatars/<id>/ and vtp-web/rooms/<id>/ from the other places this browser may hold them into `into`:
 *  every id still only in the old place is copied (its profile.json / scene.json last, so a half-copied model is never
 *  listed), read back from `into`, and only then removed from the old place. Cut short (a crash, a full disk), it goes
 *  on at the next start; localStorage vtp.store.moved records the last finished move. */
async function adopt(into: WebStore, hasOpfs: boolean) {
  const sources: WebStore[] = [];
  if (into.kind === 'idb' && hasOpfs) sources.push(opfsStore('opfs', async () => { throw new Error('read only'); }));
  if (into.kind !== 'idb' && typeof indexedDB !== 'undefined') sources.push(idbStore());
  let failAfter = Infinity;   // (tests: localStorage vtp.test.adoptFailAfter = n files, then a "crash")
  try { failAfter = Number(localStorage.getItem('vtp.test.adoptFailAfter')) || Infinity; } catch { /* storage off */ }
  for (const src of sources) {
    let any = false;
    for (const kind of ['avatars', 'rooms']) {
      const ids = (await src.list(['vtp-web', kind])).filter((e) => e.kind === 'directory' && !e.name.startsWith('.')).map((e) => e.name);
      for (const id of ids) {
        any = true;
        const base = ['vtp-web', kind, id];
        const files: string[][] = [];
        const walk = async (dir: string[], depth: number): Promise<void> => {
          for (const e of await src.list(dir)) {
            if (e.kind === 'directory') { if (depth < 6) await walk([...dir, e.name], depth + 1); } else files.push([...dir, e.name]);
          }
        };
        await walk(base, 0);
        const last = (f: string[]) => (f.length === base.length + 1 && /^(profile|scene)\.json$/.test(f[f.length - 1]) ? 1 : 0);
        files.sort((x, y) => last(x) - last(y));
        for (const f of files) {
          const b = await src.read(f);
          if (!b) continue;
          const have = await into.read(f);
          if (!have || have.size !== b.size) await into.write(f, b);
          if (++adopted > failAfter) throw new Error('stopped (test)');
        }
        // read back, then remove from the old place
        for (const f of files) { const a = await src.read(f), c = await into.read(f); if (a && (!c || c.size !== a.size)) throw new Error(`${f.join('/')} didn't copy`); }
        await src.remove(base);
        movedIds++;
      }
    }
    if (any) { try { localStorage.setItem('vtp.store.moved', JSON.stringify({ from: src.kind, to: into.kind, at: Date.now(), ids: movedIds })); } catch { /* storage off */ } console.info(`[web store] moved ${movedIds} saved models over from ${src.kind}`); }
  }
}

// ---- tests only (tools/mobile2d_e2e.mjs): crash / quota during a worker write, and what adopt() did
if (typeof window !== 'undefined') (window as unknown as { __vtpStoreTest?: unknown }).__vtpStoreTest = {
  store: () => webStore(),
  nextWorkerWrite: (t: 'stall' | 'quota' | 'retryThrows') => { nextTest = t; },
  killWorker: () => killWorker('killed (test)'),
  get adopted() { return adopted; },
  get movedIds() { return movedIds; },
  get swept() { return swept; },
  /** the raw OPFS names in a folder (temp files included) */
  rawList: async (path: string[]) => { try { const d = await opfsDir(path, false); const out: string[] = []; for await (const h of (d as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) out.push(h.name); return out.sort(); } catch { return null; } },
};
/** One sentence for "no store at all". */
export const STORE_NONE = NOPE;

/** Ask the browser to keep this site's files (Safari otherwise clears them after 7 days without a visit, unless the
 *  studio is added to the Home Screen). Asked once per page; the answer is kept. */
let persistP: Promise<boolean> | null = null;
export function askPersist(): Promise<boolean> {
  persistP ??= (async () => { try { return (await navigator.storage?.persisted?.()) || !!(await navigator.storage?.persist?.()); } catch { return false; } })();
  return persistP;
}
