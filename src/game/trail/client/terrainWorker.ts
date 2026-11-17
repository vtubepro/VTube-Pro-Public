// The Trail v2 — terrain generation off the main thread: the plan once, then chunk meshes on request (transferred).
import { planJourney, genChunk, type PlanIn, type WorldPlan, type Chunk } from '../../../../shared/trail/procgen.ts';
import { chunkMesh, coarseMesh, transfers } from './terrainMesh.ts';

let plan: WorldPlan | null = null;
const cache = new Map<string, Chunk>();
self.onmessage = (e: MessageEvent<{ t: 'plan'; opts: PlanIn } | { t: 'chunk'; cx: number; cz: number; step: number; req: number }>) => {
  const m = e.data;
  if (m.t === 'plan') { plan = planJourney(m.opts); cache.clear(); return; }
  if (!plan) return;
  const t0 = performance.now();
  if (m.step >= 4) { const mesh = coarseMesh(plan, m.cx, m.cz, m.step); (self as unknown as Worker).postMessage({ t: 'chunk', req: m.req, mesh, ms: performance.now() - t0 }, transfers(mesh)); return; }
  const k = `${m.cx},${m.cz}`;
  let c = cache.get(k);
  if (!c) { c = genChunk(plan, m.cx, m.cz); cache.set(k, c); if (cache.size > 60) cache.delete(cache.keys().next().value!); }
  const mesh = chunkMesh(plan, m.cx, m.cz, m.step, c);
  (self as unknown as Worker).postMessage({ t: 'chunk', req: m.req, mesh, ms: performance.now() - t0 }, transfers(mesh));
};
