// Avatar detail worker (one per page, created lazily by src/avatar/lod/lodClient.ts): classifies one geometry's
// triangles and builds its index-only levels with meshoptimizer (MIT, WASM; shared/lod/levels.ts). One job at a time.
// Level index arrays come back as Uint16 when the geometry has fewer than 65,535 vertices (0xFFFF is the primitive
// restart index WebGL2 always enables), else Uint32. Nothing else is touched or stored.
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';
import { levelsFromRaw, type RawLevelJob } from '../../../shared/lod/levels.ts';

export interface LodRequest { id: number; job: RawLevelJob }
export interface LodLevelMsg { index: Uint16Array | Uint32Array; tris: number; verts: number; mm: number }
export type LodResponse =
  | { id: number; ok: true; skip: string | null; faceTris: number; l0Tris: number; l0Verts: number; levels: LodLevelMsg[]; ms: number }
  | { id: number; ok: false; error: string };

const ctx = self as unknown as { onmessage: ((e: MessageEvent<LodRequest>) => void) | null; postMessage(m: LodResponse, t?: Transferable[]): void };

ctx.onmessage = async (e) => {
  const { id, job } = e.data;
  try {
    await MeshoptSimplifier.ready;
    const t0 = performance.now();
    const r = levelsFromRaw(MeshoptSimplifier, job, () => performance.now());
    if (r.skip !== null) {
      ctx.postMessage({ id, ok: true, skip: r.skip, faceTris: r.classes.F.length / 3, l0Tris: job.index.length / 3, l0Verts: 0, levels: [], ms: performance.now() - t0 });
      return;
    }
    const small = job.vcount < 65535;
    const levels: LodLevelMsg[] = r.levels.map((l) => ({ index: small ? Uint16Array.from(l.index) : l.index, tris: l.tris, verts: l.verts, mm: l.mm }));
    ctx.postMessage({ id, ok: true, skip: null, faceTris: r.faceTris, l0Tris: r.l0Tris, l0Verts: r.l0Verts, levels, ms: performance.now() - t0 }, levels.map((l) => l.index.buffer as ArrayBuffer));
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: (err as Error)?.message ?? String(err) });
  }
};
