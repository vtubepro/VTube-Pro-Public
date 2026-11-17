// A byte-capped LRU for THREE.Cache's downloaded files ('file:<url>' entries: the raw GLB / JSON bytes FileLoader keeps).
// Before this, every avatar / costume / room / emote GLB the studio ever opened stayed in memory until the tab closed.
// The cache keeps working exactly as before (switching back is instant, a repeated load is served from memory); only
// when the downloads add up to more than the cap does the least recently used UNPINNED one go. A file that was dropped
// is simply downloaded again from the helper next time (localhost). Pure logic: no THREE import, unit-tested in
// tools/cache_lru_unit.ts.
//
// Only 'file:' entries are tracked. 'image-bitmap:' / 'image:' entries are left alone: gpuDispose.releaseBitmap closes a
// bitmap once it is NOT in the cache, so dropping one a live texture still shares could close it under another user.
// FileLoader hands the bytes to its callbacks before it stores them, so a parse that is running never loses its data.

/** Default cap on the downloaded bytes THREE.Cache may hold (the live things are pinned and never count against it). */
export const CACHE_LRU_MAX_BYTES = 256 * 1024 * 1024;

/** Bytes a cached value holds (0 = unknown / small: not tracked, never evicted). */
export function cacheEntryBytes(v: unknown): number {
  if (v instanceof ArrayBuffer) return v.byteLength;
  if (ArrayBuffer.isView(v)) return v.byteLength;
  if (typeof v === 'string') return v.length * 2;
  return 0;
}

export class ByteLru {
  /** key -> bytes, oldest first (a Map keeps insertion order; touch() re-inserts). */
  private m = new Map<string, number>();
  total = 0;
  constructor(public maxBytes = CACHE_LRU_MAX_BYTES, private isPinned: (key: string) => boolean = () => false) {}

  get size() { return this.m.size; }
  has(key: string) { return this.m.has(key); }

  /** Track `key` (replacing an older entry of the same key) as the most recently used. Returns the keys that must now be
   *  dropped from the cache: oldest first, never a pinned key and never `key` itself. */
  add(key: string, bytes: number): string[] {
    this.remove(key);
    if (!(bytes > 0)) return [];
    this.m.set(key, bytes);
    this.total += bytes;
    return this.evict(key);
  }

  /** `key` was just read: it becomes the most recently used. */
  touch(key: string) {
    const b = this.m.get(key);
    if (b === undefined) return;
    this.m.delete(key);
    this.m.set(key, b);
  }

  remove(key: string) {
    const b = this.m.get(key);
    if (b === undefined) return;
    this.m.delete(key);
    this.total -= b;
  }

  clear() { this.m.clear(); this.total = 0; }

  /** Keys to drop until the total fits the cap again (call after the pins changed too). `except`: never this key. */
  evict(except?: string): string[] {
    const out: string[] = [];
    if (this.total <= this.maxBytes) return out;
    for (const [k, b] of this.m) {
      if (this.total <= this.maxBytes) break;
      if (k === except || this.isPinned(k)) continue;
      out.push(k);
      this.total -= b;
    }
    for (const k of out) this.m.delete(k);
    return out;
  }
}

/** The bits of THREE.Cache this module touches. */
export interface CacheLike {
  enabled: boolean;
  files: Record<string, unknown>;
  add(key: string, file: unknown): void;
  get(key: string): unknown;
  remove(key: string): void;
  clear(): void;
}

/** Put the LRU in front of a THREE.Cache (once, at start-up). `isPinned(key)` is asked only while evicting. */
export function installCacheLru(cache: CacheLike, isPinned: (key: string) => boolean, maxBytes = CACHE_LRU_MAX_BYTES): ByteLru {
  const lru = new ByteLru(maxBytes, isPinned);
  const add0 = cache.add, get0 = cache.get, remove0 = cache.remove, clear0 = cache.clear;
  const drop = (keys: string[]) => { for (const k of keys) remove0.call(cache, k); };
  cache.add = function (key, file) {
    add0.call(cache, key, file);
    // (Cache.add ignores blob: URLs and a disabled cache: only what it really stored is tracked)
    if (key.startsWith('file:') && cache.files[key] === file) drop(lru.add(key, cacheEntryBytes(file)));
  };
  cache.get = function (key) {
    const v = get0.call(cache, key);
    if (v !== undefined) lru.touch(key);
    return v;
  };
  cache.remove = function (key) { lru.remove(key); remove0.call(cache, key); };
  cache.clear = function () { lru.clear(); clear0.call(cache); };
  return lru;
}
