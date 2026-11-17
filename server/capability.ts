// The helper's capability report (shared/capability.ts): what this PC has, measured once and kept in memory.
//   GET /api/capability        { report, matrix }   (?fresh=1 measures again; otherwise the last answer of the past 10 minutes)
// What it reads: the graphics cards and their memory, the NVIDIA driver, processor core count + a 30-50 ms speed test, memory,
// free disk space, the OS name, and which optional packs are installed (file checks only). The same read-only probes as the Local
// AI scan (server/hwScan.ts) minus the processor's model name; nothing is written, nothing leaves this PC (the studio page that
// asked is the only reader: this PC's studio). No serial numbers, user names or paths.
import { Router } from 'express';
import { cpuBench, cpuSpeedOf, featureMatrix, type CapabilityReport, type CapGpu, type PackId } from '../shared/capability.ts';
import type { HwInfo } from '../shared/localAi/recommend.ts';
import { RIG_ML } from '../shared/rigMl.ts';
import { defaultRun, scanHardware } from './hwScan.ts';
import { DATA_DIR } from './paths.ts';

export interface CapabilityInputs {
  hw: HwInfo;
  /** NVIDIA driver major version, null = none / unknown */
  driver: number | null;
  /** cpuBench ms, null = not measured */
  benchMs: number | null;
  packs: Partial<Record<PackId, boolean>>;
  blenderVersion: string | null;
  captionsP95Ms: number | null;
}

/** Pure: probe results -> the report the studio reads (tools/capability_unit.ts feeds it fixture PCs). */
export function reportFrom(i: CapabilityInputs): CapabilityReport {
  const gpus: CapGpu[] = i.hw.gpus.map((g) => ({
    name: g.name, vendor: g.vendor, vramGB: g.vramGB, integrated: g.integrated || undefined, unified: g.unified || undefined,
    driver: g.vendor === 'nvidia' ? i.driver : null,
  }));
  return {
    v: 1, source: 'helper', helper: true,
    os: i.hw.os === 'windows' || i.hw.os === 'macos' || i.hw.os === 'linux' ? i.hw.os : 'other',
    osName: i.hw.osName, arch: i.hw.arch,
    cpu: { cores: i.hw.cpu.cores, speed: i.benchMs === null ? null : cpuSpeedOf(i.benchMs) },
    ramGB: i.hw.ramGB, diskFreeGB: i.hw.diskFreeGB, gpus,
    webgpu: null,          // the browser fills this in (src/net/capability.ts)
    packs: i.packs,
    blenderVersion: i.blenderVersion,
    measured: { captionsP95Ms: i.captionsP95Ms },
    notes: i.hw.notes.slice(0, 12),
  };
}

/** `nvidia-smi --query-gpu=driver_version --format=csv,noheader` -> 580 (first card), null when there is none. */
export function parseDriver(out: string | null): number | null {
  const m = /^\s*(\d{3,4})(\.\d+)*/m.exec(out ?? '');
  return m ? Number(m[1]) : null;
}

/** Which optional packs are installed (file checks; nothing is started). Each probe is on its own: one failing says "unknown". */
async function installedPacks(): Promise<Partial<Record<PackId, boolean>>> {
  const packs: Partial<Record<PackId, boolean>> = {};
  const tryIt = async (f: () => Promise<void> | void) => { try { await f(); } catch { /* unknown */ } };
  await tryIt(async () => {
    const { prereqs } = await import('./gpuSidecars.ts');
    const p = prereqs();
    packs.a2f = p.a2fModel && p.venv;
    packs.maxine = p.maxineSdk;
    packs.rtmw = p.rtmwModel;
  });
  await tryIt(async () => {
    const { inspect } = await import('../tools/voice/voice_setup.ts');
    const v = inspect();
    packs.captions = v.runtime && v.captionsPkgs && v.models.length > 0;
    packs.kokoro = v.runtime && v.kokoro;
  });
  await tryIt(async () => { const { installedVariant } = await import('./tracking/openSeeFace.ts'); packs.openSeeFace = installedVariant(DATA_DIR) !== null; });
  await tryIt(async () => { const { inspectRigMl } = await import('../tools/gpu/rigml_setup.ts'); packs.rigMl = inspectRigMl('skintokens', undefined, RIG_ML.skintokens).installed || inspectRigMl('unirig', undefined, RIG_ML.unirig).installed; });
  return packs;
}

/** The processor speed test blocks the helper's event loop for 30-50 ms (a game that is eating the processor stretches that
 *  to a few hundred ms, which the tracking relay to OBS feels as a hitch). A computer's speed does not change from one
 *  minute to the next, so it is measured once per BENCH_KEEP_MS and the answer reused ("Check again" costs nothing). */
export const BENCH_KEEP_MS = 30 * 60_000;
let benchLast: { at: number; ms: number } | null = null;
export function benchMemo(now: number = Date.now(), run: () => number = cpuBench): number {
  if (benchLast && now - benchLast.at < BENCH_KEEP_MS) return benchLast.ms;
  benchLast = { at: now, ms: run() };
  return benchLast.ms;
}
export function resetBenchMemo() { benchLast = null; }

export async function buildReport(): Promise<CapabilityReport> {
  const [hw, driverOut, packs, blender, captionsP95Ms] = await Promise.all([
    scanHardware(),
    defaultRun('nvidia-smi', ['--query-gpu=driver_version', '--format=csv,noheader']),
    installedPacks(),
    import('./blender.ts').then((m) => m.blenderInfo()).catch(() => null),
    import('./captions/routes.ts').then(async (m) => { const s = await m.captions.status(); return s.stats.runs > 5 ? s.stats.lagP95Ms : null; }).catch(() => null),
  ]);
  packs.blender = !!blender;
  return reportFrom({ hw, driver: parseDriver(driverOut), benchMs: benchMemo(), packs, blenderVersion: blender?.version ?? null, captionsP95Ms });
}

const KEEP_MS = 10 * 60_000;
let last: { at: number; report: CapabilityReport } | null = null;
let running: Promise<CapabilityReport> | null = null;
/** The report of the last 10 minutes, or a fresh one (callers that come while it is measured share it). */
export function capabilityReport(fresh = false): Promise<CapabilityReport> {
  if (!fresh && last && Date.now() - last.at < KEEP_MS) return Promise.resolve(last.report);
  if (running) return running;
  running = buildReport().then((report) => { last = { at: Date.now(), report }; return report; }).finally(() => { running = null; });
  return running;
}

export const capabilityRoutes = Router();
capabilityRoutes.get('/api/capability', async (req, res) => {
  const report = await capabilityReport(req.query.fresh === '1');
  res.setHeader('Cache-Control', 'no-store');
  res.json({ report, matrix: featureMatrix(report) });
});

