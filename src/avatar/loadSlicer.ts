// Model loads in frame-sized slices (docs/PERFORMANCE.md "Model loads"): an avatar / costume change or a guest joining
// builds the incoming model while the current one keeps rendering. The build gives the page back between steps once
// its time box is spent (`await sl.step()`), so no frame waits for the whole build; a newer request cancels it at the
// next step (`LoadCancelled`), so rapid costume hotkeys never build the costumes in between.
//
// Long pure steps that cannot be cut into pieces are written as generators (`yield` = "a good place to give the page
// back"; `yield { bvh }` = "build this BVH", done in a worker when one is available): `runSteps` drives them here,
// `runSync` drives the same code in one go (tests, tools, the studio's editors).
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

/** Thrown by a cancelled load at its next step (a newer request for the slot): not an error to report. */
export class LoadCancelled extends Error {
  constructor() { super('load cancelled (a newer one was requested)'); this.name = 'LoadCancelled'; }
}
export const isCancelled = (e: unknown): e is LoadCancelled => e instanceof LoadCancelled || (e as { name?: string } | null)?.name === 'LoadCancelled';

/** A request a step generator yields: nothing (a place to give the page back) or a BVH to build. */
export type StepRequest = undefined | { bvh: THREE.BufferGeometry };
export type Steps<T> = Generator<StepRequest, T, MeshBVH | undefined>;

const BVH_OPTS = { maxLeafSize: 8 } as const;

export interface SlicerOptions {
  /** Time box per slice, ms (default 6). */
  budgetMs?: number;
  /** true = the load is stale (a newer request came): the next step throws LoadCancelled. */
  cancelled?: () => boolean;
  /** How to give the page back (default: a macrotask; tests pass their own). */
  yieldFn?: () => Promise<void>;
  /** Build a BVH off the main thread (default: src/avatar/bvhWorker.ts when Workers exist). null = on this thread. */
  bvh?: ((g: THREE.BufferGeometry) => Promise<MeshBVH>) | null;
}

// a macrotask that does not wait for a timer clamp (MessageChannel), so the browser can draw a frame in between
const channelYield = (): (() => Promise<void>) => {
  if (typeof MessageChannel === 'undefined') return () => new Promise((r) => setTimeout(r, 0));
  const ch = new MessageChannel();
  const q: (() => void)[] = [];
  ch.port1.onmessage = () => { q.shift()?.(); };
  return () => new Promise<void>((r) => { q.push(r); ch.port2.postMessage(0); });
};
let sharedYield: (() => Promise<void>) | null = null;

export class LoadSlicer {
  readonly budgetMs: number;
  private t0 = performance.now();
  private readonly yieldFn: () => Promise<void>;
  /** Stats: slices given back, the longest slice (ms), the time spent building (ms, without the waits). */
  readonly stats = { yields: 0, longest: 0, busyMs: 0 };

  constructor(private readonly o: SlicerOptions = {}) {
    this.budgetMs = o.budgetMs ?? 6;
    this.yieldFn = o.yieldFn ?? (sharedYield ??= channelYield());
  }

  /** Throws LoadCancelled when the load went stale. */
  check() { if (this.o.cancelled?.()) throw new LoadCancelled(); }

  /** Between two pieces of work: gives the page back when this slice's time box is spent; throws if cancelled. */
  async step(): Promise<void> {
    this.check();
    const now = performance.now();
    if (now - this.t0 < this.budgetMs) return;
    await this.pause(now);
  }

  /** Always give the page back (before a piece of work known to be long). */
  async yield(): Promise<void> {
    this.check();
    await this.pause(performance.now());
  }

  private async pause(now: number) {
    const ms = now - this.t0;
    this.stats.busyMs += ms; this.stats.longest = Math.max(this.stats.longest, ms); this.stats.yields++;
    await this.yieldFn();
    this.check();
    this.t0 = performance.now();
  }

  /** Builds a BVH: in the worker when there is one (the page keeps drawing), else here, as one piece of work. */
  async bvh(g: THREE.BufferGeometry): Promise<MeshBVH> {
    const off = this.o.bvh === undefined ? defaultBvh() : this.o.bvh;
    if (off) {
      const tw = performance.now();
      this.stats.busyMs += tw - this.t0;
      try { const b = await off(g); this.check(); this.t0 = performance.now(); return b; }
      catch (e) { if (isCancelled(e)) throw e; this.t0 = performance.now(); /* the worker failed: build it here */ }
    }
    await this.yield();
    return new MeshBVH(g, BVH_OPTS);
  }
}

/** Drives a step generator in slices (yields between pieces, BVHs via the slicer). */
export async function runSteps<T>(g: Steps<T>, sl: LoadSlicer): Promise<T> {
  let r = g.next();
  while (!r.done) {
    const req = r.value;
    if (req && req.bvh) {
      let b: MeshBVH;
      try { b = await sl.bvh(req.bvh); } catch (e) { g.return(undefined as never); throw e; }
      r = g.next(b);
    } else {
      try { await sl.step(); } catch (e) { g.return(undefined as never); throw e; }
      r = g.next();
    }
  }
  return r.value;
}

/** Drives a step generator in one go (BVHs built here). */
export function runSync<T>(g: Steps<T>): T {
  let r = g.next();
  while (!r.done) r = g.next(r.value?.bvh ? new MeshBVH(r.value.bvh, BVH_OPTS) : undefined);
  return r.value;
}

// ---------------------------------------------------------------- BVH worker (src/avatar/bvhWorker.ts)
type BvhWorkerLike = { postMessage(m: unknown, t?: Transferable[]): void; onmessage: ((e: MessageEvent) => void) | null; onerror: ((e: unknown) => void) | null; terminate(): void };
let worker: BvhWorkerLike | null = null, workerBroken = false, seq = 0;
const waiting = new Map<number, { res: (s: unknown) => void; rej: (e: unknown) => void }>();
function defaultBvh(): ((g: THREE.BufferGeometry) => Promise<MeshBVH>) | null {
  if (workerBroken || typeof Worker === 'undefined') return null;
  return bvhInWorker;
}
function ensureWorker(): BvhWorkerLike {
  if (worker) return worker;
  const w = new Worker(new URL('./bvhWorker.ts', import.meta.url), { type: 'module', name: 'vtp-bvh' }) as unknown as BvhWorkerLike;
  w.onmessage = (e: MessageEvent) => {
    const { id, serialized, error } = e.data as { id: number; serialized?: unknown; error?: string };
    const p = waiting.get(id); waiting.delete(id);
    if (!p) return;
    if (error) p.rej(new Error(error)); else p.res(serialized);
  };
  w.onerror = (e) => { workerBroken = true; for (const p of waiting.values()) p.rej(new Error(`bvh worker: ${(e as { message?: string })?.message ?? 'failed'}`)); waiting.clear(); try { w.terminate(); } catch { /* gone */ } worker = null; };
  return (worker = w);
}
async function bvhInWorker(g: THREE.BufferGeometry): Promise<MeshBVH> {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const idx = g.index;
  if (!pos || (pos as unknown as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute) throw new Error('bvh worker: no plain position attribute');
  // (copies: the geometry stays usable while the worker builds)
  const position = new Float32Array(pos.array as ArrayLike<number>);
  const index = idx ? new Uint32Array(idx.array as ArrayLike<number>) : null;
  const id = ++seq;
  const w = ensureWorker();
  const serialized = await new Promise<unknown>((res, rej) => {
    waiting.set(id, { res, rej });
    w.postMessage({ id, position, index, options: BVH_OPTS }, index ? [position.buffer, index.buffer] : [position.buffer]);
  });
  // (the BVH reorders the index: it comes back with it and replaces the geometry's)
  return MeshBVH.deserialize(serialized as Parameters<typeof MeshBVH.deserialize>[0], g, { setIndex: true });
}

/** Every skinned mesh under `root` without a bounding box gets the one three.js would compute (each vertex skinned at
 *  the current pose: SkinnedMesh.computeBoundingBox), in slices — later Box3.setFromObject calls just read it. */
export async function skinnedBoxes(root: THREE.Object3D, sl: LoadSlicer): Promise<void> {
  const list: THREE.SkinnedMesh[] = [];
  root.traverse((o) => { const m = o as THREE.SkinnedMesh; if (m.isSkinnedMesh && m.boundingBox === null && m.geometry?.attributes.position) list.push(m); });
  const v = new THREE.Vector3();
  for (const m of list) {
    const n = m.geometry.attributes.position.count;
    const box = new THREE.Box3();
    for (let i = 0; i < n; i++) {
      m.getVertexPosition(i, v);
      box.expandByPoint(v);
      if ((i & 2047) === 2047) await sl.step();
    }
    // (a box someone computed meanwhile wins; else ours)
    m.boundingBox ??= box;
    await sl.step();
  }
}
