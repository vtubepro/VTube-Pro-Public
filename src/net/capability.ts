// "What can my PC do?" in the studio: VTube Pro's measured report (GET /api/capability, server/capability.ts) plus what only
// the browser can see (WebGPU), or, when the server does not answer, a smaller report the browser measures itself:
// graphics card name, processor cores and speed, rough memory.
// One answer per page, kept 10 minutes; capabilityNow() is the last answer without waiting (null before the first).
import { featureMatrix, cpuBench, cpuSpeedOf, isIntegrated, sanitizeReport, vendorOf, type CapabilityReport, type FeatureId, type FeatureRow } from '../../shared/capability.ts';

export interface Capability {
  report: CapabilityReport;
  matrix: FeatureRow[];
  /** 'ok' = the server measured it, 'none' = the server did not answer (the browser's own smaller report) */
  helper: 'ok' | 'none';
}

const KEEP_MS = 10 * 60_000;
let last: { at: number; cap: Capability } | null = null;
let running: Promise<Capability> | null = null;
const fns = new Set<(c: Capability) => void>();

/** WebGPU in this browser: an adapter within 1.5 s (the same test as the lip-sync guide). */
export async function detectWebGpu(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    const a = await Promise.race([gpu.requestAdapter(), new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
    return !!a;
  } catch { return false; }
}

/** "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)" -> "NVIDIA GeForce RTX 3060". */
export function rendererName(raw: string): string {
  const angle = /^ANGLE \(([^,]+),\s*(.+?)(\s*\(0x[0-9a-f]+\))?\s*(Direct3D|OpenGL|Vulkan|Metal|,)/i.exec(raw);
  return (angle ? angle[2] : raw).replace(/\s+/g, ' ').trim().slice(0, 120);
}

function webglRenderer(): string {
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  } catch { return ''; }
}

function browserOs(): CapabilityReport['os'] {
  const p = ((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.userAgent).toLowerCase();
  return /win/.test(p) ? 'windows' : /mac/.test(p) ? 'macos' : /linux|x11/.test(p) ? 'linux' : 'other';
}

/** What the page alone can measure (the server did not answer). Nothing leaves the page. */
export async function browserReport(helper: boolean, webgpu: boolean): Promise<CapabilityReport> {
  const raw = webglRenderer();
  const name = raw ? rendererName(raw) : '';
  const vendor = /apple/i.test(name) ? 'apple' : vendorOf(name);
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  await new Promise((r) => setTimeout(r, 0));      // let the page paint before the 30-50 ms speed test
  return {
    v: 1, source: 'browser', helper, os: browserOs(), osName: '', arch: '',
    // a warm-up run first: a browser's JIT needs a moment before the loop runs at full speed
    cpu: { cores: Math.max(1, navigator.hardwareConcurrency || 1), speed: (cpuBench(), cpuSpeedOf(cpuBench())) },
    // navigator.deviceMemory stops at 8 GB and is missing in some browsers: a floor, not the real size
    ramGB: typeof mem === 'number' && mem < 8 ? mem : null,
    diskFreeGB: null,
    gpus: name ? [{ name, vendor, vramGB: null, integrated: isIntegrated(name) || undefined, unified: vendor === 'apple' || undefined }] : [],
    webgpu, packs: {}, notes: ['Measured by the browser: start VTube Pro for the full check (graphics memory, disk space, installed packs).'],
  };
}

async function measure(fresh: boolean): Promise<Capability> {
  const webgpu = await detectWebGpu();
  try {
    const r = await fetch(`/api/capability${fresh ? '?fresh=1' : ''}`, { cache: 'no-store' });
    const report = r.ok ? sanitizeReport((await r.json())?.report) : null;
    if (report) { report.webgpu = webgpu; return { report, matrix: featureMatrix(report), helper: 'ok' }; }
  } catch { /* fall through to the browser's own report */ }
  const report = await browserReport(false, webgpu);
  return { report, matrix: featureMatrix(report), helper: 'none' };
}

/** The capability answer (the last 10 minutes', or a fresh measurement). */
export function getCapability(fresh = false): Promise<Capability> {
  if (!fresh && last && Date.now() - last.at < KEEP_MS) return Promise.resolve(last.cap);
  if (running) return running;
  running = measure(fresh).then((cap) => {
    last = { at: Date.now(), cap };
    for (const f of fns) { try { f(cap); } catch { /* listener */ } }
    return cap;
  }).finally(() => { running = null; });
  return running;
}
export const capabilityNow = (): Capability | null => last?.cap ?? null;
/** Called with every new answer. Returns the way to stop listening. */
export function onCapability(fn: (c: Capability) => void): () => void { fns.add(fn); return () => fns.delete(fn); }
/** One feature's row (waits for the first answer). */
export const featureNow = (id: FeatureId): FeatureRow | null => last?.cap.matrix.find((f) => f.id === id) ?? null;
