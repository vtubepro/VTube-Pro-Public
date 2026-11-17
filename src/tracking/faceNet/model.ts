// "My face model" stage 2, what is kept (docs/FACE_MODEL.md): ONLY the weights JSON (with its per-channel mask and the
// feature mean / std and output priors the net needs) + date + teacher + the judge-frame numbers, in IndexedDB; the last three
// versions with one-click revert, like learnMe. Settings (use / share / which version) are a few bytes in localStorage.
// Pure over two tiny interfaces so the state machine runs in Node on a fake store.
import type { ModelStats } from './teach.ts';

export const FACEMODEL_KEY = 'vtp.faceModel';
export const MAX_VERSIONS = 3;

export interface ModelRecord { id: string; at: string; json: string; stats: ModelStats }
export interface ModelStore { all(): Promise<ModelRecord[]>; put(r: ModelRecord): Promise<void>; remove(id: string): Promise<void>; clear(): Promise<void> }
export interface Prefs { v: 1; /** the "Use my face model" switch */ use: boolean; /** 0..1 share of the net in each channel it was adopted for */ share: number; /** id of the version in use; null = none (standard) */ current: string | null }
export interface PrefStore { load(): Prefs; save(p: Prefs): void }
export const DEFAULT_PREFS: Prefs = { v: 1, use: false, share: 1, current: null };

export class MemoryModelStore implements ModelStore {
  rows = new Map<string, ModelRecord>();
  async all() { return [...this.rows.values()].map((r) => ({ ...r })); }
  async put(r: ModelRecord) { this.rows.set(r.id, { ...r }); }
  async remove(id: string) { this.rows.delete(id); }
  async clear() { this.rows.clear(); }
}
export class MemoryPrefStore implements PrefStore {
  p: Prefs = { ...DEFAULT_PREFS };
  load() { return { ...this.p }; }
  save(p: Prefs) { this.p = { ...p }; }
}

/** localStorage prefs ('vtp.faceModel'). Observer studios (`readOnly`) read but never write: they share localStorage with the live one. */
export function localPrefStore(readOnly: boolean): PrefStore {
  return {
    load() {
      try { const s = globalThis.localStorage?.getItem(FACEMODEL_KEY); const p = s ? JSON.parse(s) as Prefs : null; if (p && p.v === 1) return { ...DEFAULT_PREFS, ...p, share: clamp01(p.share) }; } catch { /* storage off */ }
      return { ...DEFAULT_PREFS };
    },
    save(p) { if (!readOnly) try { globalThis.localStorage?.setItem(FACEMODEL_KEY, JSON.stringify(p)); } catch { /* storage off */ } },
  };
}

const DB = 'vtp-facemodel', STORE = 'models';
function openDb(): Promise<IDBDatabase | null> {
  return new Promise((res) => {
    try {
      if (typeof indexedDB === 'undefined') { res(null); return; }
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: 'id' }); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
    } catch { res(null); }
  });
}
function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | null> {
  return openDb().then((db) => new Promise<T | null>((res) => {
    if (!db) { res(null); return; }
    try {
      const t = db.transaction(STORE, mode), s = t.objectStore(STORE);
      const r = fn(s);
      t.oncomplete = () => { db.close(); res(r ? r.result : null); };
      t.onerror = t.onabort = () => { db.close(); res(null); };
    } catch { db.close(); res(null); }
  }));
}
/** The browser's IndexedDB; every call fails soft (no storage = nothing is kept, the model just lasts this session). */
export function idbModelStore(): ModelStore {
  return {
    async all() { return (await tx<ModelRecord[]>('readonly', (s) => s.getAll())) ?? []; },
    async put(r) { await tx('readwrite', (s) => s.put(r)); },
    async remove(id) { await tx('readwrite', (s) => s.delete(id)); },
    async clear() { await tx('readwrite', (s) => s.clear()); },
  };
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1);

/** Versions + settings: adopt / revert / delete. Listeners fire after every change. */
export class FaceModelManager {
  prefs: Prefs;
  /** oldest first, at most MAX_VERSIONS */
  versions: ModelRecord[] = [];
  /** the latest teach attempt, adopted or not (memory only; the panel's "what happened") */
  last: { at: string; adopted: boolean; why: string; stats: ModelStats | null } | null = null;
  private listeners = new Set<() => void>();
  constructor(private store: ModelStore, private pref: PrefStore) { this.prefs = pref.load(); }
  onChange(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit() { for (const f of this.listeners) try { f(); } catch { /* ui */ } }
  private save() { this.pref.save(this.prefs); this.emit(); }

  async init() {
    this.versions = (await this.store.all()).sort((a, b) => a.at.localeCompare(b.at)).slice(-MAX_VERSIONS);
    if (this.prefs.current && !this.versions.some((v) => v.id === this.prefs.current)) this.prefs = { ...this.prefs, current: null, use: false };
    this.emit();
  }
  get current(): ModelRecord | null { return this.versions.find((v) => v.id === this.prefs.current) ?? null; }
  /** The version the tracker should run: the current one while the switch is on. */
  get active(): ModelRecord | null { return this.prefs.use ? this.current : null; }

  setUse(on: boolean) { this.prefs = { ...this.prefs, use: on && !!this.current }; this.save(); }
  setShare(v: number) { this.prefs = { ...this.prefs, share: clamp01(v) }; this.save(); }

  /** A teach run finished. Adopted: keep it (last 3), make it current and switch it ON. Otherwise: keep everything as it was and say why. */
  async finishTeach(rec: ModelRecord | null, stats: ModelStats | null, why: string) {
    const adopted = !!rec && !!stats?.adopted;
    this.last = { at: new Date().toISOString(), adopted, why, stats };
    if (adopted && rec) {
      await this.store.put(rec);
      this.versions = [...this.versions.filter((v) => v.id !== rec.id), rec].sort((a, b) => a.at.localeCompare(b.at));
      while (this.versions.length > MAX_VERSIONS) await this.store.remove(this.versions.shift()!.id);
      this.prefs = { ...this.prefs, current: rec.id, use: true };
      this.save();
    } else this.emit();
    return adopted;
  }
  /** One-click revert: an older version, or `null` = standard tracking (nothing personal). */
  revertTo(id: string | null) {
    const ok = id !== null && this.versions.some((v) => v.id === id);
    // picking a version means using it; "standard" (or a version that is gone) means off, so a badge can never say "in use" for a model that is off
    this.prefs = { ...this.prefs, current: ok ? id : null, use: ok };
    this.save();
  }
  /** Delete removes all of it: every version, the settings' pointer, the switch. */
  async deleteAll() {
    await this.store.clear();
    this.versions = []; this.last = null;
    this.prefs = { ...this.prefs, current: null, use: false };
    this.save();
  }
}
