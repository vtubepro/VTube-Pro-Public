// The ~10-second quality benchmark (first run in the Scene tab, or Scene tab → Graphics quality → Run benchmark).
// Runs INSIDE a render page (the studio's Scene-tab preview): renders the current room at High for ~5 s, then at Medium
// for ~5 s, reads the GPU time per frame from the page's timer query (OutputPerf windows, p90), scales it from the
// preview's size to a 1920×1080 OBS frame, and picks the highest preset that fits the render budget:
//   budget = 40 % of the target frame time (6.7 ms at 60 fps) — the face tracker, OBS's encoder and the game share
//   the same GPU, so the room may only take a slice of it.
// CPU-aware: the page's own main-thread time per frame (p95) at each level must fit half the frame (8.3 ms at 60 fps):
// High / Ultra's post chain is mostly CPU-side draw submission, and on a mid-range PC the processor runs out before the
// graphics card does (docs/PERFORMANCE.md §6). A level whose CPU time doesn't fit is not picked, however fast the GPU.
// Ultra is never auto-picked (the user opts in). Without a GPU timer query (some browsers / drivers) the pick comes from
// the GPU's name (src/stage/gfx/gpuClass.ts). Nothing here saves anything: the studio decides what to do with the result.
import type { GfxBenchResult, GfxLevel } from '../../../shared/graphics.ts';
import type { PerfSnapshot } from '../../outputPerf.ts';
import { gpuClass, rendererString } from './gpuClass.ts';

export interface BenchTarget {
  /** Force a level for the benchmark (null = back to the page's own choice). */
  benchLevel(l: GfxLevel | null): void;
  readonly stage: { renderer: { getContext(): WebGLRenderingContext | WebGL2RenderingContext; domElement: HTMLCanvasElement } };
}

const OBS_PIXELS = 1920 * 1080;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait for the next `n` fresh perf windows (~2 s each) and return the last one. */
async function windows(perf: () => PerfSnapshot | null, n: number, timeout = 9000): Promise<PerfSnapshot | null> {
  let last = perf(), got = 0;
  const t0 = performance.now();
  while (got < n && performance.now() - t0 < timeout) {
    await sleep(100);
    const s = perf();
    if (s && s !== last) { last = s; got++; }
  }
  return got ? last : null;
}

/** The benchmark's pick (pure; tools/perf_unit.ts): GPU ms (p90, scaled to 1080p) within 40 % of the frame, the page's
 *  main-thread ms (p95) within 50 % of it, integrated GPUs never above Medium; no GPU numbers = the GPU class's pick. */
export function benchPick(ms: Partial<Record<GfxLevel, number>>, cpu: Partial<Record<GfxLevel, number>>, cls: { integrated: boolean; pick: GfxLevel }, targetFps = 60): GfxLevel {
  const budget = (1000 / targetFps) * 0.4, cpuBudget = (1000 / targetFps) * 0.5;
  let pick: GfxLevel;
  if (ms.high !== undefined && ms.balanced !== undefined) {
    pick = ms.high <= budget ? 'high' : ms.balanced <= budget ? 'balanced' : 'performance';
    // integrated GPUs share memory bandwidth with the CPU (and the tracker): never above Medium
    if (cls.integrated && pick === 'high') pick = 'balanced';
  } else pick = cls.pick;
  // the processor too: step down while the level's main-thread time doesn't fit (unknown = no say)
  const cpuFits = (l: GfxLevel) => !(typeof cpu[l] === 'number' && (cpu[l] as number) > cpuBudget);
  if (pick === 'high' && !cpuFits('high')) pick = 'balanced';
  if (pick === 'balanced' && !cpuFits('balanced')) pick = 'performance';
  return pick;
}

export async function runGfxBench(g: BenchTarget, perf: () => PerfSnapshot | null, opts: { targetFps?: number; room?: string | null } = {}): Promise<GfxBenchResult> {
  const gl = g.stage.renderer.getContext();
  const gpu = rendererString(gl);
  const cls = gpuClass(gpu);
  const target = opts.targetFps ?? 60;
  const ms: Partial<Record<GfxLevel, number>> = {};
  const cpu: Partial<Record<GfxLevel, number>> = {};
  let timer = true;
  try {
    for (const l of ['high', 'balanced'] as GfxLevel[]) {
      g.benchLevel(l);
      await windows(perf, 1);                         // the window the switch happened in (compile / warm-up)
      const s = await windows(perf, 2);
      if (s && Number.isFinite(s.frameP95)) cpu[l] = +s.frameP95.toFixed(2);
      if (!s || !Number.isFinite(s.gpuP90)) { timer = false; if (l === 'high') continue; break; }
      const px = Math.max(1, s.width * s.height);
      // GPU time is mostly per-pixel at these sizes; a small preview under-reads the OBS cost → scale up (≤ ×8)
      const k = Math.min(8, Math.max(1, OBS_PIXELS / px)) * 0.85 + 0.15;
      ms[l] = +(s.gpuP90 * k).toFixed(2);
    }
  } finally { g.benchLevel(null); }
  const pick = benchPick(timer ? ms : {}, cpu, cls, target);
  return { at: Date.now(), gpu: gpu.slice(0, 120), cls: cls.label, how: timer ? 'timer' : 'name', ms, cpu, pick, room: opts.room ?? null };
}
