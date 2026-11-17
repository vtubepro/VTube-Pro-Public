// "What can my PC do?": one capability report (hardware + installed packs) and the per-feature matrix the studio shows
// where the user meets each feature (a chip, a disabled button with the reason, the "What can my PC do?" page) and the web
// studio shows with no helper. Pure (no node:, no DOM): the helper builds the report (server/capability.ts, GET
// /api/capability), the browser fills in what only it can see (WebGPU) or builds a smaller report itself when there is no
// helper (src/net/capability.ts), and tools/capability_unit.ts runs the matrix on fixture PCs.
//
// Every row is 'ok' / 'slower' / 'no' with ONE plain sentence, what you get instead, and what would fix it. No jargon
// (memory vtube-pro-zero-effort): "graphics card", "video memory", "disk space", never CUDA / VRAM / ONNX.
// Measured, not guessed, where it is cheap: the CPU speed is a 30-50 ms test run on the user's own machine (cpuBench), the
// graphics card and its memory come from the system (server/hwScan.ts), the captions delay is the captions engine's own
// measurement once it has run. The facts behind each threshold are cited next to the constant.
import { classifyGpu, A2F_MIN_DRIVER, A2F_MIN_VRAM_MB } from './gpuClass.ts';
import { RIG_ML, STAGED_FLOOR_GB, stagedMinutes } from './rigMl.ts';
import { RTMW_NEEDS_RTX50 } from './gpuLicence.ts';
import { BLENDER_MIN } from './blenderSetup.ts';

export type CapStatus = 'ok' | 'slower' | 'no';
/** What the PC can do (the hardware answer). Whether the feature is installed is a second answer: see capState / capWord. */
export const CAP_WORDS: Record<CapStatus, string> = { ok: 'Ready', slower: 'Ready, slower', no: 'Not on this PC' };

export type CapVendor = 'nvidia' | 'amd' | 'intel' | 'apple' | 'other';
export interface CapGpu {
  name: string;
  vendor: CapVendor;
  /** dedicated video memory in GB; null = unknown or shared with the system (integrated / Apple) */
  vramGB: number | null;
  integrated?: boolean;
  unified?: boolean;
  /** NVIDIA driver major version (e.g. 580), when known */
  driver?: number | null;
}
export type PackId = 'a2f' | 'maxine' | 'rtmw' | 'openSeeFace' | 'captions' | 'kokoro' | 'rigMl' | 'blender';
export interface CapabilityReport {
  v: 1;
  /** who measured it: the helper (everything), or the browser alone (no helper: GPU name, cores, rough memory) */
  source: 'helper' | 'browser';
  /** is the free helper app running behind this studio? */
  helper: boolean;
  os: 'windows' | 'macos' | 'linux' | 'other';
  osName: string;
  arch: string;
  cpu: {
    cores: number;
    /** measured speed, 1.0 = the reference PC (CPU_REF); null = not measured */
    speed: number | null;
  };
  ramGB: number | null;
  diskFreeGB: number | null;
  gpus: CapGpu[];
  /** WebGPU in this browser: true / false, null = not checked (the helper cannot see the browser) */
  webgpu: boolean | null;
  /** installed optional packs (missing key = unknown) */
  packs: Partial<Record<PackId, boolean>>;
  /** Blender's version when it was found */
  blenderVersion?: string | null;
  /** numbers the engines measured themselves (better than any estimate) */
  measured?: { captionsP95Ms?: number | null };
  /** probe notes (never personal data) */
  notes: string[];
}

// ---------------------------------------------------------------- naming a graphics card (also server/hwScan.ts)
export function vendorOf(name: string): CapVendor {
  const n = name.toLowerCase();
  if (/nvidia|geforce|quadro|rtx|gtx|tesla/.test(n)) return 'nvidia';
  if (/\bamd\b|radeon|ati\b|advanced micro devices/.test(n)) return 'amd';
  if (/intel|arc\b|iris|uhd graphics|hd graphics/.test(n)) return 'intel';
  if (/apple|\bm[1-9]\b/.test(n)) return 'apple';
  return 'other';
}
/** Integrated GPUs share system RAM: not useful for AI memory budgets. */
export function isIntegrated(name: string): boolean {
  const n = name.toLowerCase();
  if (/intel/.test(n)) return !/\barc\b/.test(n) || /arc\(tm\) graphics$|arc graphics$/.test(n); // "Intel(R) Arc(TM) Graphics" = Meteor Lake iGPU
  if (/radeon/.test(n)) return !/\brx\b|radeon pro|\bw\d{4}|vega (56|64)|radeon vii|instinct|\bmi\d{2,3}\b/.test(n);
  return false;
}
// ---------------------------------------------------------------- CPU speed (measured)
/** The work cpuBench times: the same on every machine. */
export const CPU_BENCH_LOOPS = 2_000_000;
/** cpuBench's best-of-3 time on the reference PC: 14.3 ms on an AMD Ryzen 9 9950X3D (Node 24 / V8, 2026-10-24), the PC VTube
 *  Pro is built and measured on. A typical 6-core gaming PC from 2019-2021 scores about 0.5-0.6. Chrome / Edge run the same
 *  V8 engine as the helper; Firefox / Safari scores are rougher (they only matter when the server does not answer). */
export const CPU_REF_MS = 14.3;
export const CPU_REF = 'a Ryzen 9 9950X3D desktop';
let benchSink = 0;
/** Time a fixed, single-threaded maths loop (best of 3, about 30-50 ms on a normal PC). Lower ms = faster. */
export function cpuBench(now: () => number = () => performance.now()): number {
  let best = Infinity;
  for (let run = 0; run < 3; run++) {
    const t0 = now();
    let x = 0;
    for (let i = 1; i < CPU_BENCH_LOOPS; i++) x += Math.sqrt(i) * Math.sin(i * 0.001);
    benchSink += x;
    best = Math.min(best, now() - t0);
  }
  return Math.max(0.1, best);
}
/** cpuBench ms -> speed (1.0 = the reference PC; 0.5 = half as fast). */
export const cpuSpeedOf = (ms: number): number => Math.round((CPU_REF_MS / Math.max(0.1, ms)) * 100) / 100;
/** The speed that counts for work spread over several threads (captions, voice): single-thread speed, scaled down below 4 cores. */
export const multiSpeed = (cpu: CapabilityReport['cpu']): number | null => (cpu.speed === null ? null : cpu.speed * Math.min(Math.max(cpu.cores, 1), 4) / 4);

// ---------------------------------------------------------------- graphics card class
/** -1 = no graphics card (software drawing), 0 = basic built-in graphics, 1 = GTX 1060 / RX 580 class, 2 = GTX 1080 /
 *  RTX 3060 / RX 6600, 3 = RTX 3060 Ti / RX 6700 XT, 4 = RTX 4070 Ti / RX 7900 and up. Tiers 1-4 are exactly the classes
 *  shared/graphics.ts GFX_LABELS names for Low / Medium / High / Ultra. */
export type GpuPerf = -1 | 0 | 1 | 2 | 3 | 4;

const NV_CLASS: [RegExp, GpuPerf][] = [
  [/\b50(90|80)\b|\b5070\s*ti\b/, 4], [/\b5070\b|\b5060\s*ti\b|\b5060\b/, 3], [/\b5050\b/, 2],
  [/\b40(90|80)\b|\b4070\s*(ti|super)\b/, 4], [/\b4070\b|\b4060\b/, 3], [/\b4050\b/, 2],   // a desktop RTX 4060 is close to a 3060 Ti
  [/\b3090\b|\b3080\s*ti\b/, 4], [/\b3080\b|\b3070\b|\b3060\s*ti\b/, 3], [/\b3060\b/, 2], [/\b3050\b/, 1],
  [/\b2080\b/, 3], [/\b20(70|60)\b/, 2],
  [/\b16(60|50)\b/, 1], [/\b10(80|70)\b/, 2], [/\b1060\b/, 1], [/\b10(50|30)\b/, 0],
];
const AMD_CLASS: [RegExp, GpuPerf][] = [
  [/\b9070\b|\b7900\b|\b6950\b|\b6900\b/, 4], [/\b9060\b|\b7800\b|\b7700\b|\b6800\b|\b6750\b|\b6700\b/, 3],
  [/\b7600\b|\b6650\b|\b6600\b|\b5700\b|\b5600\b|vega\s*(56|64)/, 2], [/\b6500\b|\b5500\b|\b590\b|\b580\b|\b570\b/, 1],
];
/** How strong is this graphics card for VTube Pro's rooms? (name first; video memory only for cards we can't name) */
export function gpuPerf(g: CapGpu | null | undefined): GpuPerf {
  if (!g) return -1;
  // "RX 6700M" / "RTX 3080 M": the M suffix marks a laptop chip; split it off so the model number still matches below
  const n = g.name.toLowerCase().replace(/(\d{3,4})\s?m\b/, '$1 mobile');
  if (/basic (display|render)|swiftshader|llvmpipe|software|microsoft basic/.test(n)) return -1;
  const laptop = /laptop|mobile|max-q/.test(n) ? 1 : 0;
  const down = (c: GpuPerf): GpuPerf => Math.max(0, c - laptop) as GpuPerf;
  if (g.vendor === 'apple') {
    if (/\bultra\b/.test(n)) return 4;
    if (/\bmax\b/.test(n)) return 3;
    if (/\bpro\b/.test(n)) return 2;
    return /\bm[3-9]\b/.test(n) ? 2 : 1;          // base M1 / M2: Low class; base M3 and newer: Medium
  }
  if (g.integrated) return 0;
  if (g.vendor === 'nvidia') {
    for (const [re, c] of NV_CLASS) if (re.test(n)) return down(c);
    if (/\b(rtx|quadro|titan)\b/.test(n)) return down(g.vramGB !== null && g.vramGB >= 12 ? 3 : 2);
  }
  if (g.vendor === 'amd') for (const [re, c] of AMD_CLASS) if (re.test(n)) return down(c);
  if (g.vendor === 'intel') {
    if (/\bb5[78]0\b|\ba7[57]0\b|\ba580\b/.test(n)) return 2;
    if (/\ba[35]\d0\b/.test(n)) return 1;
    return 0;
  }
  if (g.vramGB !== null) return g.vramGB >= 8 ? 2 : g.vramGB >= 4 ? 1 : 0;
  return 0;
}

/** The graphics card that does the work: the strongest one (a laptop's NVIDIA card over its built-in Intel one). */
export function mainGpu(r: Pick<CapabilityReport, 'gpus'>): CapGpu | null {
  const real = r.gpus.filter((g) => gpuPerf(g) >= 0);
  if (!real.length) return null;
  return [...real].sort((a, b) => gpuPerf(b) - gpuPerf(a) || (b.vramGB ?? 0) - (a.vramGB ?? 0))[0];
}
/** Memory a graphics card can give an AI model: its own video memory, or about two thirds of a Mac's shared memory. */
export function aiMemoryGB(r: Pick<CapabilityReport, 'gpus' | 'ramGB'>): number {
  const g = mainGpu(r);
  if (!g) return 0;
  if (g.unified) return r.ramGB ? Math.round(r.ramGB * 0.66 * 10) / 10 : 0;
  return g.integrated ? 0 : g.vramGB ?? 0;
}

// ---------------------------------------------------------------- the matrix
export type FeatureId =
  | 'gpu-lipsync' | 'maxine' | 'rtmw' | 'openseeface' | 'face-model' | 'captions' | 'kokoro' | 'see-through' | 'rig-ml'
  | 'blender-rig' | 'picture-to-life' | 'arms-front' | 'gfx-performance' | 'gfx-balanced' | 'gfx-high' | 'gfx-ultra';
export const FEATURE_IDS: readonly FeatureId[] = ['gpu-lipsync', 'maxine', 'rtmw', 'openseeface', 'face-model', 'captions', 'kokoro',
  'see-through', 'rig-ml', 'blender-rig', 'picture-to-life', 'arms-front', 'gfx-performance', 'gfx-balanced', 'gfx-high', 'gfx-ultra'];

export interface FeatureRow {
  id: FeatureId;
  name: string;
  status: CapStatus;
  /** one plain sentence: why this status on this PC */
  why: string;
  /** what you get instead (or alongside, when slower) */
  fallback: string;
  /** what would fix it ("Needs an NVIDIA RTX card with 8 GB", "Free 6 GB of disk space"); null = nothing to do */
  fix: string | null;
  /** needs the helper app */
  helper: boolean;
  /** its optional pack is installed (null = no pack, or unknown) */
  installed: boolean | null;
  /** not built into VTube Pro yet ("Coming soon"): the PC check is only a preview of what it will need */
  soon?: boolean;
}

/** The three plain answers the user sees (plus "coming soon"): the PC is capable AND the feature is installed = ready; capable
 *  but not installed = can run once set up; not capable = not on this PC. "Works" is never said for something that is not installed. */
export type CapState = 'ready' | 'setup' | 'no' | 'soon';
export function capState(f: Pick<FeatureRow, 'status' | 'installed' | 'soon'>): CapState {
  if (f.soon) return 'soon';
  if (f.status === 'no') return 'no';
  return f.installed === false ? 'setup' : 'ready';
}
/** The chip / badge text for a feature: "Ready", "Ready, slower", "Can run — set it up", "Can run, slower — set it up", "Not on this PC", "Coming soon". */
export function capWord(f: Pick<FeatureRow, 'status' | 'installed' | 'soon'>): string {
  const s = capState(f);
  if (s === 'soon') return 'Coming soon';
  if (s === 'no') return CAP_WORDS.no;
  if (s === 'setup') return f.status === 'slower' ? 'Can run, slower — set it up' : 'Can run — set it up';
  return CAP_WORDS[f.status];
}
/** Where to press "set up" for a feature that is capable but not installed (one next step, in the app's own words). */
export const SETUP_WHERE: Partial<Record<FeatureId, string>> = {
  'gpu-lipsync': 'Tracking → Advanced → Voice, phone & 2nd camera → “Set up GPU tracking”.',
  maxine: 'Tracking → Advanced → Voice, phone & 2nd camera → “+ NVIDIA AR SDK (Maxine)”.',
  rtmw: 'Tracking → Advanced → Voice, phone & 2nd camera → “Set up GPU tracking”.',
  openseeface: 'Tracking → Advanced → “If face tracking can’t keep up” → “Get the light face tracker”.',
  captions: 'Tracking → Advanced → Voice, phone & 2nd camera → Live captions → “Install live captions”.',
  kokoro: 'In Chat Hub’s alert voice, pick Kokoro → “Install the Kokoro voice”.',
  'rig-ml': 'Me → Body & physics → Smart skeleton → “Install”.',
  'blender-rig': 'Install Blender (free, about 1 GB) first; the auto-rig runs in it.',
};
/** One short next step for a state, for the page's rows and tooltips ('' when there is nothing to do). */
export function capNext(f: FeatureRow): string {
  const s = capState(f);
  if (s === 'setup') return `Not installed yet. ${SETUP_WHERE[f.id] ?? 'Open its panel and press its set-up button.'}`;
  return '';
}

export const INSTALL_HELPER = 'Start VTube Pro';
const NEEDS_HELPER = 'This runs in the VTube Pro app on your PC.';

// Download sizes in GB (installed size, plus room to unpack). Sources: docs/GPU_TRACKING.md (Audio2Face runtime 2.1 GB + model
// 0.31 GB; Maxine about 2 GB installed), docs/LIVE_CAPTIONS.md (captions about 0.6 GB, Kokoro 92 MB model), server/tracking/
// openSeeFace.ts (about 5 MB), shared/rigMl.ts (diskGB), Blender's own installer (about 1 GB).
export const PACK_GB: Record<PackId, number> = { a2f: 2.5, maxine: 2, rtmw: 0.5, openSeeFace: 0.01, captions: 0.6, kokoro: 0.11, rigMl: RIG_ML.skintokens.diskGB, blender: 1 };
/** Room left over after an install (Windows misbehaves on a full disk). */
export const DISK_MARGIN_GB = 1;
/** Captions: a run (one ~2 s window) over this measured p95 delay means words arrive late (server/captions/manager.ts advice at 2 s). */
export const CAPTIONS_LAG_MS = 2000;
/** CPU speed (multi-thread, 1.0 = reference) below which captions switch to quick mode / fall well behind
 *  (docs/LIVE_CAPTIONS.md: quick mode when a run passes 0.35 s; over 0.8 s per run the 2 s target cannot be met). */
export const CAPTIONS_QUICK_SPEED = 0.45;
export const CAPTIONS_BEHIND_SPEED = 0.2;
/** Kokoro (onnxruntime on the processor, about 300 MB while it talks): below this speed each line takes noticeably longer to start. */
export const KOKORO_SLOW_SPEED = 0.35;
/** General "this PC is slow" line for work that runs on the processor in the page (Picture to life, My face model, OpenSeeFace). */
export const PAGE_SLOW_SPEED = 0.4;
/** See-through layer splitting (docs/AUTORIG_ROADMAP.md: 8-16 GB of video memory, 2-3 min per picture). */
export const SEE_THROUGH_MIN_GB = 8;
export const SEE_THROUGH_BEST_GB = 16;

const TIER_NEED: Record<'gfx-performance' | 'gfx-balanced' | 'gfx-high' | 'gfx-ultra', { cls: 1 | 2 | 3 | 4; name: string; like: string }> = {
  'gfx-performance': { cls: 1, name: 'Room quality: Low', like: 'a GTX 1060 or RX 580' },
  'gfx-balanced': { cls: 2, name: 'Room quality: Medium', like: 'a GTX 1080, RTX 3060 or RX 6600' },
  'gfx-high': { cls: 3, name: 'Room quality: High', like: 'an RTX 3060 Ti or RX 6700 XT' },
  'gfx-ultra': { cls: 4, name: 'Room quality: Ultra', like: 'an RTX 4070 Ti or RX 7900' },
};

const gb = (n: number) => (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10);

/** Not enough disk for a pack that is not installed yet: the fix sentence, else null. */
function diskShort(r: CapabilityReport, pack: PackId): string | null {
  if (r.packs[pack] || r.diskFreeGB === null) return null;
  const need = PACK_GB[pack] + DISK_MARGIN_GB;
  return r.diskFreeGB < need ? `Free ${Math.max(1, Math.ceil(need - r.diskFreeGB))} GB of disk space` : null;
}

type Row = Omit<FeatureRow, 'id' | 'name' | 'helper' | 'installed'>;
const row = (status: CapStatus, why: string, fallback: string, fix: string | null): Row => ({ status, why, fallback, fix });

/** Every feature on this PC, in FEATURE_IDS order. */
export function featureMatrix(r: CapabilityReport): FeatureRow[] {
  return FEATURE_IDS.map((id) => featureRow(r, id));
}

export const FEATURE_NAMES: Record<FeatureId, string> = {
  // one name per feature, the same as on the feature's own panel (src/ui/gpuPanel.ts, faceChainPanel.ts, skeletonPanel.ts)
  'gpu-lipsync': 'GPU lip sync (Audio2Face)', maxine: 'Face expressions (NVIDIA Maxine)', rtmw: 'Whole-body & finger pose (RTMW)',
  openseeface: 'Light face tracker', 'face-model': 'My face model', captions: 'Live captions', kokoro: 'Kokoro voice',
  'see-through': 'Split a picture into layers (See-through)', 'rig-ml': 'Smart skeleton', 'blender-rig': 'Skeleton for anything',
  'picture-to-life': 'Picture to life', 'arms-front': 'Arms in front',
  'gfx-performance': TIER_NEED['gfx-performance'].name, 'gfx-balanced': TIER_NEED['gfx-balanced'].name, 'gfx-high': TIER_NEED['gfx-high'].name, 'gfx-ultra': TIER_NEED['gfx-ultra'].name,
};
const HELPER_FEATURE: Record<FeatureId, boolean> = {
  'gpu-lipsync': true, maxine: true, rtmw: true, openseeface: true, 'face-model': false, captions: true, kokoro: true, 'see-through': true,
  'rig-ml': true, 'blender-rig': true, 'picture-to-life': false, 'arms-front': false,
  'gfx-performance': false, 'gfx-balanced': false, 'gfx-high': false, 'gfx-ultra': false,
};
const PACK_OF: Partial<Record<FeatureId, PackId>> = { 'gpu-lipsync': 'a2f', maxine: 'maxine', rtmw: 'rtmw', openseeface: 'openSeeFace', captions: 'captions', kokoro: 'kokoro', 'rig-ml': 'rigMl', 'blender-rig': 'blender' };

export function featureRow(r: CapabilityReport, id: FeatureId): FeatureRow {
  const pack = PACK_OF[id];
  const helper = HELPER_FEATURE[id];
  const base = { id, name: FEATURE_NAMES[id], helper, installed: pack && r.helper ? r.packs[pack] ?? null : null, ...(id === 'see-through' ? { soon: true } : {}) };
  const body = rule(r, id);
  // no helper: a helper feature can't run, whatever the hardware says (the hardware line is kept as a hint)
  if (helper && !r.helper && id !== 'see-through') {
    return { ...base, status: 'no', why: NEEDS_HELPER, fallback: body.fallback, fix: INSTALL_HELPER };
  }
  return { ...base, ...body };
}

function rule(r: CapabilityReport, id: FeatureId): Row {
  const g = mainGpu(r);
  const nv = r.gpus.filter((x) => x.vendor === 'nvidia').sort((a, b) => (b.vramGB ?? 0) - (a.vramGB ?? 0))[0] ?? null;
  const speed = r.cpu.speed;
  const multi = multiSpeed(r.cpu);
  switch (id) {
    case 'gpu-lipsync': {
      const fallback = 'The browser lip sync, which works on any PC.';
      if (!nv) return row('no', 'GPU lip sync needs an NVIDIA graphics card, and this PC has none.', fallback, 'Needs an NVIDIA RTX graphics card (20-series or newer) with 4 GB of video memory');
      const c = classifyGpu(nv.name, (nv.vramGB ?? 0) * 1024);
      if (!c.series) return row('no', `Your ${nv.name} is not an RTX card, which GPU lip sync needs.`, fallback, 'Needs an NVIDIA RTX graphics card (20-series or newer) with 4 GB of video memory');
      if (c.a2f === 'none') return row('no', `Your ${nv.name} has less than ${A2F_MIN_VRAM_MB / 1024} GB of video memory.`, fallback, `Needs an NVIDIA RTX card with ${A2F_MIN_VRAM_MB / 1024} GB of video memory`);
      if (nv.driver && nv.driver < A2F_MIN_DRIVER) return row('no', `Your graphics driver (${nv.driver}) is too old for GPU lip sync.`, fallback, `Update your NVIDIA driver to version ${A2F_MIN_DRIVER} or newer (free, from nvidia.com)`);
      const disk = diskShort(r, 'a2f');
      if (disk) return row('no', 'There is not enough free disk space to install GPU lip sync (about 2.5 GB).', fallback, disk);
      if (c.a2f === 'untested') return row('ok', `Should work on your ${nv.name}, but it has only been tested on an RTX 5090.`, fallback, null);
      return row('ok', `Your ${nv.name} runs GPU lip sync (tested on RTX 50-series).`, fallback, null);
    }
    case 'maxine': {
      const fallback = 'Your webcam tracking keeps reading your expressions.';
      if (r.os !== 'windows' && r.os !== 'other') return row('no', 'NVIDIA face expressions only exist for Windows.', fallback, 'Needs a Windows PC with an NVIDIA RTX 50-series card');
      if (!nv || classifyGpu(nv.name).series !== 50) return row('no', 'VTube Pro supports NVIDIA face expressions on RTX 50-series cards only, so far.', fallback, 'Needs an NVIDIA RTX 50-series graphics card');
      const disk = diskShort(r, 'maxine');
      if (disk) return row('no', 'There is not enough free disk space for NVIDIA\'s installer (about 2 GB).', fallback, disk);
      return row('ok', `Your ${nv.name} can run NVIDIA face expressions (NVIDIA's free installer asks you first).`, fallback, null);
    }
    case 'rtmw': {
      const fallback = 'MediaPipe\u2019s built-in body and hand tracking from your webcam, which works on any PC.';
      // RTMW needs an NVIDIA RTX 50-series card and nothing else; every other PC gets the one plain notice (shared/gpuLicence.ts)
      if (!nv || classifyGpu(nv.name).series !== 50) return row('no', RTMW_NEEDS_RTX50, fallback, 'Needs an NVIDIA RTX 50-series graphics card');
      const disk = diskShort(r, 'rtmw');
      if (disk) return row('no', 'There is not enough free disk space for the whole-body model (about 0.5 GB).', fallback, disk);
      return row('ok', `Your ${nv.name} can run whole-body and finger tracking (the model is downloaded from OpenMMLab when you set it up).`, fallback, null);
    }
    case 'openseeface': {
      const fallback = 'The normal webcam tracker.';
      if (speed !== null && speed < PAGE_SLOW_SPEED) return row('slower', 'Runs on your processor, which is on the slow side: tracking may update less often.', fallback, null);
      return row('ok', 'A small (5 MB) face tracker that runs on the processor, for PCs where the normal one struggles.', fallback, null);
    }
    case 'face-model': {
      const fallback = 'The normal webcam face tracking.';
      if (speed !== null && speed < PAGE_SLOW_SPEED) return row('slower', 'Learning your face takes longer on this processor; tracking itself is unchanged.', fallback, null);
      return row('ok', 'Learns your face on this PC (stored here, about 80 KB) and sharpens expressions the webcam misses.', fallback, null);
    }
    case 'captions': {
      const fallback = 'No captions; the stream itself is not affected.';
      const disk = diskShort(r, 'captions');
      if (disk) return row('no', 'There is not enough free disk space to install captions (about 0.6 GB).', fallback, disk);
      const p95 = r.measured?.captionsP95Ms;
      if (typeof p95 === 'number' && p95 > 0) {
        if (p95 > CAPTIONS_LAG_MS) return row('slower', `Measured: captions show up about ${gb(p95 / 1000)} s after you speak on this PC.`, fallback, 'A faster processor, or the smaller "tiny" captions model');
        return row('ok', `Measured: captions show up within about ${gb(p95 / 1000)} s.`, fallback, null);
      }
      if (r.cpu.cores < 2) return row('no', 'Captions need a processor with at least 2 cores.', fallback, 'Needs a processor with 2 or more cores');
      if (multi !== null && multi < CAPTIONS_BEHIND_SPEED) return row('slower', 'Your processor is slow for captions: expect them 3 seconds or more behind your voice.', fallback, 'A faster processor, or the smaller "tiny" captions model');
      if (multi !== null && multi < CAPTIONS_QUICK_SPEED) return row('slower', 'Captions use quick mode on this processor: about 2-3 seconds behind your voice.', fallback, null);
      return row('ok', 'Captions should show up within about 2 seconds of your voice.', fallback, null);
    }
    case 'kokoro': {
      const fallback = 'This computer\'s own voice reads the line.';
      const disk = diskShort(r, 'kokoro');
      if (disk) return row('no', 'There is not enough free disk space for the Kokoro voice (about 110 MB).', fallback, disk);
      if (r.ramGB !== null && r.ramGB < 4) return row('no', 'The Kokoro voice needs about 300 MB of free memory while it talks; this PC has very little.', fallback, 'Needs a PC with 4 GB of memory or more');
      if (multi !== null && multi < KOKORO_SLOW_SPEED) return row('slower', 'Each line takes a moment longer to start on this processor.', fallback, null);
      return row('ok', 'Reads chat aloud with a natural voice, on the processor (no graphics card needed).', fallback, null);
    }
    case 'see-through': {
      const fallback = 'Picture to life rigs a flat picture without splitting it into layers.';
      const mem = aiMemoryGB(r);
      if (mem >= SEE_THROUGH_MIN_GB) return row('no', `Not in VTube Pro yet. When it arrives, your graphics card (${gb(mem)} GB) is big enough${mem < SEE_THROUGH_BEST_GB ? ' for normal pictures' : ''}.`, fallback, null);
      const g0 = mainGpu(r);
      // a dedicated card whose memory nobody could read (the browser alone): don't call it too small
      if (g0 && !g0.integrated && !g0.unified && g0.vramGB === null) return row('no', 'Not in VTube Pro yet. When it arrives it will need a graphics card with 8 GB of video memory (VTube Pro checks yours).', fallback, null);
      return row('no', 'Not in VTube Pro yet. When it arrives it will need a graphics card with 8 GB of video memory.', fallback, `Needs a graphics card with ${SEE_THROUGH_MIN_GB} GB of video memory (${SEE_THROUGH_BEST_GB} GB for big pictures)`);
    }
    case 'rig-ml': {
      const fallback = 'Skeleton for anything (Blender) rigs your model instead.';
      // tiers (shared/rigMl.ts): full speed (UniRig 8 GB / SkinTokens 14 GB), the slower low-memory staged mode down to the floor, then the Blender skeleton
      const best = RIG_ML.skintokens.minVramGB, small = RIG_ML.unirig.minVramGB, floor = STAGED_FLOOR_GB.unirig;
      if (!nv) return row('no', 'The smart skeleton needs an NVIDIA graphics card, and this PC has none. The Blender skeleton is used instead.', fallback, `Needs an NVIDIA graphics card with ${small} GB of video memory (${best} GB for the best model)`);
      const have = nv.vramGB ?? 0;
      if (have < floor) return row('no', `Your ${nv.name} has ${gb(have)} GB of video memory; the smart skeleton needs at least ${floor} GB (${small} GB for full speed, ${best} GB for the best model). The Blender skeleton is used instead.`, fallback, `Needs an NVIDIA graphics card with ${small} GB of video memory (${best} GB for the best model)`);
      const model = have >= best ? RIG_ML.skintokens : RIG_ML.unirig;
      if (!r.packs.rigMl && r.diskFreeGB !== null && r.diskFreeGB < model.diskGB + DISK_MARGIN_GB) return row('no', `There is not enough free disk space for the smart skeleton (about ${model.diskGB} GB).`, fallback, `Free ${Math.max(1, Math.ceil(model.diskGB + DISK_MARGIN_GB - r.diskFreeGB))} GB of disk space`);
      if (have < small) return row('slower', `Slower: staged low-memory mode. Your ${nv.name} has ${gb(have)} GB of video memory (${small} GB is full speed), so the smart skeleton works on a smaller copy of your model, one step at a time: about ${stagedMinutes('unirig', have)} minutes.`, fallback, `A graphics card with ${small} GB of video memory runs it at full speed (${best} GB for the best model)`);
      if (have < best) return row('slower', `Your ${nv.name} runs the smaller smart skeleton model; the best one needs ${best} GB of video memory.`, fallback, `A graphics card with ${best} GB of video memory runs the best model`);
      return row('ok', `Your ${nv.name} can run the best smart skeleton model.`, fallback, null);
    }
    case 'blender-rig': {
      const fallback = 'Pick a model that already has a skeleton (VRM), or use Picture to life for flat art.';
      if (r.packs.blender === false) {
        const disk = diskShort(r, 'blender');
        return row('no', 'Blender (free) is not installed, and the auto-rig runs in it.', fallback, `${disk ? `${disk}, then install` : 'Install'} Blender ${BLENDER_MIN} or newer (free, about 1 GB)`);
      }
      if (r.cpu.cores < 4 || (speed !== null && speed < PAGE_SLOW_SPEED)) return row('slower', 'Rigging runs on the processor and takes a few minutes longer on this PC.', fallback, null);
      return row('ok', 'Blender rigs your model on this PC in the background.', fallback, null);
    }
    case 'picture-to-life': {
      const fallback = 'Pro2D\'s manual rig editor.';
      if (speed !== null && speed < PAGE_SLOW_SPEED) return row('slower', 'Works; building the rig takes longer on this processor.', fallback, null);
      return row('ok', 'Turns one flat picture into a moving 2D avatar, right in the page.', fallback, null);
    }
    case 'arms-front':
      return row('ok', 'Works on any PC (not for flat 2D, four-legged or mech bodies).', 'Arms down by your sides.', null);
    case 'gfx-performance': case 'gfx-balanced': case 'gfx-high': case 'gfx-ultra': {
      const t = TIER_NEED[id];
      const cls = gpuPerf(g);
      const fallback = 'Auto picks the best level by measuring how smoothly your stream really runs.';
      const card = g ? `Your ${g.name}` : 'This PC has no graphics card, so';
      if (cls >= t.cls) return row('ok', `${g ? `Your ${g.name}` : 'This PC'} handles it.`, fallback, null);
      if (!g) return row(id === 'gfx-performance' ? 'slower' : 'no', `${card} rooms are drawn on the processor and will be slow.`, fallback, `Needs a graphics card like ${t.like}`);
      if (cls === t.cls - 1) return row('slower', `${card} can run it, but big rooms may stutter.`, fallback, `For a smooth stream: a graphics card like ${t.like}`);
      return row('no', `${card} is too weak for this level.`, fallback, `Needs a graphics card like ${t.like}`);
    }
  }
}

/** Short chip text for a feature (hardware answer + installed or not). */
export const chipText = (f: Pick<FeatureRow, 'status' | 'installed' | 'soon'>) => capWord(f);
/** The tooltip / disabled-button reason: the sentence, then the fix or the fallback. */
export function reasonText(f: FeatureRow): string {
  const parts = [f.why];
  const next = capNext(f);
  if (next) parts.push(next);
  if (f.status !== 'ok' && f.fix) parts.push(`${f.fix}.`);
  if (f.status !== 'ok' && f.fallback) parts.push(`Instead: ${f.fallback}`);
  return parts.join(' ').replace(/\.\./g, '.');
}

/** Validate an untrusted report (from the network or another tab): null when it is not one. */
export function sanitizeReport(v: unknown): CapabilityReport | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.v !== 1 || !Array.isArray(o.gpus) || !o.cpu || typeof o.cpu !== 'object') return null;
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  const str = (x: unknown, n = 120) => (typeof x === 'string' ? x.slice(0, n) : '');
  const vendors: CapVendor[] = ['nvidia', 'amd', 'intel', 'apple', 'other'];
  const cpu = o.cpu as Record<string, unknown>;
  const packs: Partial<Record<PackId, boolean>> = {};
  for (const [k, val] of Object.entries((o.packs ?? {}) as Record<string, unknown>)) if (k in PACK_GB && typeof val === 'boolean') packs[k as PackId] = val;
  const measured = (o.measured ?? {}) as Record<string, unknown>;
  return {
    v: 1, source: o.source === 'browser' ? 'browser' : 'helper', helper: o.helper === true,
    os: (['windows', 'macos', 'linux'] as const).find((x) => x === o.os) ?? 'other', osName: str(o.osName), arch: str(o.arch, 16),
    cpu: { cores: Math.max(1, Math.min(512, Math.round(num(cpu.cores) ?? 1))), speed: num(cpu.speed) },
    ramGB: num(o.ramGB), diskFreeGB: num(o.diskFreeGB),
    gpus: (o.gpus as unknown[]).slice(0, 8).filter((g): g is Record<string, unknown> => !!g && typeof g === 'object').map((g) => ({
      name: str(g.name), vendor: vendors.find((x) => x === g.vendor) ?? 'other', vramGB: num(g.vramGB),
      integrated: g.integrated === true || undefined, unified: g.unified === true || undefined, driver: num(g.driver),
    })),
    webgpu: typeof o.webgpu === 'boolean' ? o.webgpu : null,
    packs,
    blenderVersion: typeof o.blenderVersion === 'string' ? str(o.blenderVersion, 24) : null,
    measured: { captionsP95Ms: num(measured.captionsP95Ms) },
    notes: Array.isArray(o.notes) ? o.notes.filter((x): x is string => typeof x === 'string').slice(0, 12).map((x) => x.slice(0, 160)) : [],
  };
}
