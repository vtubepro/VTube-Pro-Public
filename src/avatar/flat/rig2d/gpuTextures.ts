// Main-thread side of the 2D texture worker (gpuTexWorker.ts): KTX2 page → this GPU's format, off the main thread.
// One worker per page (two on a desktop), kept for the page's lifetime; jobs are queued.
import type { GpuTarget } from '../../../../shared/rig2d/gpu/basis.ts';
import { webTierWriter } from './tierStore.ts';

const BASE = (() => {
  const b = `${(import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/'}vendor/basis/`;
  try { return new URL(b, location.href).href; } catch { return b; }
})();

interface Done { width: number; height: number; levels: Uint8Array[]; ms: number }
type Slot = { w: Worker; busy: boolean };
const slots: Slot[] = [];
const queue: { ktx2: Uint8Array; target: GpuTarget; resolve: (d: Done) => void; reject: (e: Error) => void }[] = [];
const pending = new Map<number, { resolve: (d: Done) => void; reject: (e: Error) => void; slot: Slot }>();
let seq = 0;

function pump(max: number) {
  while (slots.length < max && queue.length > slots.filter((s) => !s.busy).length) {
    const w = new Worker(new URL('./gpuTexWorker.ts', import.meta.url), { type: 'module', name: 'vtp-tex' });
    const slot: Slot = { w, busy: false };
    w.onmessage = (e: MessageEvent<{ id: number; error?: string } & Partial<Done>>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      p.slot.busy = false;
      if (e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data as Done);
      pump(max);
    };
    w.onerror = (e) => { for (const [id, p] of pending) if (p.slot === slot) { pending.delete(id); p.reject(new Error(e.message || 'texture worker failed')); } slot.busy = false; };
    slots.push(slot);
  }
  for (const s of slots) {
    if (s.busy || !queue.length) continue;
    const j = queue.shift()!, id = ++seq;
    s.busy = true;
    pending.set(id, { resolve: j.resolve, reject: j.reject, slot: s });
    s.w.postMessage({ id, base: BASE, ktx2: j.ktx2, target: j.target }, [j.ktx2.buffer as ArrayBuffer]);
  }
}

/** Transcode one KTX2 page (its bytes are handed over: don't use them after). */
export function transcodeKtx2(ktx2: Uint8Array, target: GpuTarget, workers = 1): Promise<Done> {
  return new Promise((resolve, reject) => { queue.push({ ktx2, target, resolve, reject }); pump(Math.max(1, workers)); });
}

let building: Promise<unknown> | null = null;
/** A page without VTube Pro's server (browser-only): make the model's ≤ 4096 tiers in a worker of its own (single-threaded, one at a
 *  time per page: gpuTexWorker.ts 'build'); each file is stored beside the model through the browser store chain
 *  (tierStore.ts). Resolves the key it built, or throws. */
export function buildTiersInBrowser(avatar: string, model: Uint8Array, key: string, onProgress?: (done: number, of: number) => void): Promise<{ key: string; tiers: number[] }> {
  const run = async () => {
    const w = new Worker(new URL('./gpuTexWorker.ts', import.meta.url), { type: 'module', name: 'vtp-tex-build' });
    try {
      return await new Promise<{ key: string; tiers: number[] }>((resolve, reject) => {
        const write = webTierWriter(avatar, key);
        w.onmessage = (e: MessageEvent<{ progress?: [number, number]; built?: { key: string; tiers: number[] }; error?: string; write?: { n: number; rel: string; bytes: Uint8Array } }>) => {
          if (e.data.write) {
            const { n, rel, bytes } = e.data.write;
            write(rel, bytes).then(() => w.postMessage({ t: 'ack', n }), (err) => w.postMessage({ t: 'ack', n, error: (err as Error).message || 'could not save' }));
            return;
          }
          if (e.data.progress) onProgress?.(e.data.progress[0], e.data.progress[1]);
          else if (e.data.built) resolve(e.data.built);
          else reject(new Error(e.data.error ?? 'the texture worker stopped'));
        };
        w.onerror = (e) => reject(new Error(e.message || 'the texture worker stopped'));
        w.postMessage({ id: 1, t: 'build', base: BASE, model, key }, [model.buffer as ArrayBuffer]);
      });
    } finally { w.terminate(); }
  };
  // (one build at a time on a page: phones have little memory)
  const p = (building ?? Promise.resolve()).catch(() => undefined).then(run);
  building = p.catch(() => undefined);
  return p;
}
