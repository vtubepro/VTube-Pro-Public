// "Keep learning me" — the training data: compact, privacy-safe FEATURE frames (never video, never audio).
//
// One frame (≤ 30 Hz, only while the performer opted in, is tracked well and the studio is not an observer):
//   voice   level, the five vowel weights, lip closure, voiced flag, pitch (semitones vs their own median),
//           the 17 viseme posteriors                                  — numbers the lip-sync engine already computes
//   camera  the solved mouth (open / wide / round / pucker) and the 52 raw ARKit blendshapes
//   pose    head rotation + position, gaze, torso angles, upper / lower arm directions
//   trust   the tracker's adaptive quality level, both eyes tracked
// Stored as chunks (≈ 1 minute each) in this browser's IndexedDB on this PC: a Float32 time track + one Uint16 per
// field (fixed ranges below; head angles resolve to ≈ 0.002°). ≈ 6.5 KB/s → a 200 MB cap holds ≈ 8.5 hours; the
// oldest chunks rotate out. Nothing here is ever uploaded, and party guests never pass through the collector.
import { VISEMES } from './visemes.ts';
import { ARKIT } from '../core/arkit.ts';

export const LM_VERSION = 1;
/** Field layout (index → meaning). */
export const F = {
  level: 0, vowels: 1 /* ×5 A E I O U */, closure: 6, voiced: 7, pitch: 8, visemes: 9 /* ×17 */,
  camOpen: 26, camWide: 27, camRound: 28, camPucker: 29, arkit: 30 /* ×52 */,
  head: 82 /* ×3 rad */, headPos: 85 /* ×3 m */, gaze: 88 /* ×2 */, torso: 90 /* ×3 rad */, arms: 93 /* ×12: upL loL upR loR */,
  quality: 105, eyesBoth: 106, hasVoice: 107, hasBody: 108,
} as const;
export const LM_F = 109;
/** Value range per field for the Uint16 quantisation. */
export const RANGE: [number, number][] = Array.from({ length: LM_F }, (_, i) => {
  if (i === F.pitch) return [-12, 12];
  if (i >= F.head && i < F.head + 3) return [-1.6, 1.6];
  if (i >= F.headPos && i < F.headPos + 3) return [-1, 1];
  if (i >= F.gaze && i < F.gaze + 2) return [-1.5, 1.5];
  if (i >= F.torso && i < F.torso + 3) return [-1.6, 1.6];
  if (i >= F.arms && i < F.arms + 12) return [-1, 1];
  if (i === F.quality) return [0, 4];
  return [0, 1];
});
export const ARKIT_INDEX = new Map<string, number>(ARKIT.map((n, i) => [n, F.arkit + i]));
export const VISEME_ORDER = VISEMES;

/** A chunk as stored: session id, wall-clock start, frame times (s, performance clock of that session), fields. */
export interface LmChunk { id?: number; v: number; session: string; at: number; n: number; t: Float32Array; q: Uint16Array }
/** Decoded frames for fitting: t[n], x[n*LM_F]. */
export interface LmFrames { t: Float64Array; x: Float32Array; n: number; session: string[] }

export function quantize(x: ArrayLike<number>, out: Uint16Array, o: number) {
  for (let i = 0; i < LM_F; i++) {
    const [a, b] = RANGE[i];
    const v = Number.isFinite(x[i]) ? (x[i] - a) / (b - a) : 0;
    out[o + i] = Math.round(Math.max(0, Math.min(1, v)) * 65535);
  }
}
export function dequantize(q: Uint16Array, o: number, out: Float32Array, p: number) {
  for (let i = 0; i < LM_F; i++) { const [a, b] = RANGE[i]; out[p + i] = a + (q[o + i] / 65535) * (b - a); }
}
export function chunkBytes(c: LmChunk) { return c.t.byteLength + c.q.byteLength + 64; }

/** Concatenate chunks (sorted by wall clock) into one decoded frame table. */
export function decodeChunks(chunks: LmChunk[]): LmFrames {
  const cs = [...chunks].sort((a, b) => a.at - b.at || (a.id ?? 0) - (b.id ?? 0));
  const n = cs.reduce((s, c) => s + c.n, 0);
  const t = new Float64Array(n), x = new Float32Array(n * LM_F), session: string[] = new Array(n);
  let k = 0, off = 0, lastSession = '', lastT = -Infinity;
  for (const c of cs) {
    // one continuous timeline: sessions are separated by a 60-s gap (so every window / segment logic breaks there)
    if (c.session !== lastSession) { off = (Number.isFinite(lastT) ? lastT + 60 : 0) - (c.t[0] ?? 0); lastSession = c.session; }
    for (let i = 0; i < c.n; i++, k++) {
      t[k] = c.t[i] + off; lastT = t[k];
      dequantize(c.q, i * LM_F, x, k * LM_F);
      session[k] = c.session;
    }
  }
  return { t, x, n, session };
}

// ---------------- IndexedDB store (browser / worker; every call fails soft) ----------------

const DB = 'vtp-learnme', STORE = 'chunks';
function openDb(): Promise<IDBDatabase | null> {
  return new Promise((res) => {
    try {
      if (typeof indexedDB === 'undefined') { res(null); return; }
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true }); };
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
export const lmStore = {
  async add(c: LmChunk) { return tx('readwrite', (s) => s.add(c)); },
  async all(): Promise<LmChunk[]> { return (await tx<LmChunk[]>('readonly', (s) => s.getAll())) ?? []; },
  async clear() { await tx('readwrite', (s) => s.clear()); },
  async remove(ids: number[]) { if (ids.length) await tx('readwrite', (s) => { for (const id of ids) s.delete(id); }); },
  /** Stored size and learned duration (frames at ≈ 30 Hz → seconds from the real frame times). */
  async stats(): Promise<{ bytes: number; seconds: number; chunks: number }> {
    const cs = await this.all();
    let bytes = 0, seconds = 0;
    for (const c of cs) { bytes += chunkBytes(c); seconds += spanSeconds(c); }
    return { bytes, seconds, chunks: cs.length };
  },
  /** Drop the oldest chunks until the store fits `capBytes`. */
  async rotate(capBytes: number) {
    const cs = (await this.all()).sort((a, b) => a.at - b.at);
    let total = cs.reduce((s, c) => s + chunkBytes(c), 0);
    const drop: number[] = [];
    for (const c of cs) { if (total <= capBytes) break; total -= chunkBytes(c); if (c.id !== undefined) drop.push(c.id); }
    await this.remove(drop);
    return drop.length;
  },
};
/** Seconds of recorded (good) time in a chunk: sum of frame steps, ignoring the gaps between kept runs. */
export function spanSeconds(c: { t: Float32Array; n: number }) {
  let s = 0;
  for (let i = 1; i < c.n; i++) { const d = c.t[i] - c.t[i - 1]; if (d > 0 && d < 0.25) s += d; }
  return s;
}
